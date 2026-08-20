// tests/delegate-manager.test.ts — modern /delegate live lifecycle and exactly-once finalization
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegateManager,
  type DelegateProcessResult,
} from '../src/application/autonomy/delegateManager.js';
import { createEventBus } from '../src/kernel/events.js';
import { createRunContext } from '../src/protocol/runs.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options: {
  timeoutMs?: number;
  terminateOk?: boolean;
  cleanupOk?: boolean;
  launchGate?: Promise<void>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-delegate-'));
  dirs.push(dir);
  const bus = createEventBus(dir);
  const completions = new Map<string, ReturnType<typeof deferred<DelegateProcessResult>>>();
  const order: string[] = [];
  let pid = 40;
  const manager = createDelegateManager({
    bus,
    timeoutMs: options.timeoutMs ?? 60_000,
    idFactory: () => `d${pid}`,
    worktrees: {
      add: async taskId => {
        order.push(`add:${taskId}`);
        return { ok: true, value: { path: `${dir}/worktrees/${taskId}` } };
      },
      remove: async taskId => {
        order.push(`remove:${taskId}`);
        return options.cleanupOk === false
          ? { ok: false as const, error: { code: 'WORKTREE_REMOVE_FAILED', message: 'x', messageKey: 'x', retryable: false } }
          : { ok: true as const, value: undefined };
      },
    },
    process: {
      start: async (_goal, cwd) => {
        const taskId = cwd.split('/').at(-1)!;
        const completion = deferred<DelegateProcessResult>();
        completions.set(taskId, completion);
        const processId = pid++;
        order.push(`start:${taskId}`);
        await options.launchGate;
        return {
          ok: true,
          value: {
            processId,
            completion: completion.promise,
            terminate: async () => {
              order.push(`terminate:${taskId}`);
              return options.terminateOk === false
                ? { ok: false as const, error: { code: 'SUBAGENT_STOP_FAILED', message: 'x', messageKey: 'x', retryable: false } }
                : { ok: true as const, value: undefined };
            },
          },
        };
      },
    },
    fence: async lineage => {
      order.push(`fence:${lineage.join('>')}`);
      return { ok: true, value: undefined };
    },
  });
  return { bus, manager, completions, order };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('DelegateManager', () => {
  it('returns a live receipt immediately and inherits parent correlation/session identity', async () => {
    const h = harness();
    const parent = createRunContext({ runId: 'parent-run', correlationId: 'parent-corr', sessionId: 'parent-session' });
    const started = await h.manager.start({ goal: 'inspect repository', parentContext: parent });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value).toMatchObject({ taskId: 'd40', processId: 40, goal: 'inspect repository', status: 'running' });
    expect(started.value.runContext).toMatchObject({
      runId: 'delegate:d40',
      correlationId: 'parent-corr',
      sessionId: 'parent-session',
    });
    expect(h.manager.listActive()).toHaveLength(1);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toHaveLength(0);

    h.completions.get('d40')!.resolve({ exitCode: 0, signal: null, stdout: 'done', stderr: '' });
    await settle();
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.order).toEqual(['add:d40', 'start:d40', 'remove:d40']);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toEqual([
      expect.objectContaining({
        runId: 'delegate:d40',
        correlationId: 'parent-corr',
        sessionId: 'parent-session',
        payload: expect.objectContaining({ status: 'succeeded' }),
      }),
    ]);
  });

  it('seals async work created by a final listener', async () => {
    const h = harness();
    const marker = `delegate-final-listener-${Date.now()}`;
    const off = h.bus.on('run.final', event => {
      if (event.runId !== 'delegate:d40') return;
      setTimeout(() => h.bus.emit('agent.token', { marker }), 0);
    });

    try {
      await h.manager.start({ goal: 'seal final scope', sessionId: 's1' });
      h.completions.get('d40')!.resolve({ exitCode: 0, signal: null, stdout: 'done', stderr: '' });
      await settle();
      await settle();

      const late = h.bus.history().find(event => event.payload?.marker === marker);
      expect(late).toBeDefined();
      expect(late?.runId).toBeUndefined();
    } finally {
      off();
    }
  });

  it('maps nonzero exit to failed and retains bounded process output in completion event', async () => {
    const h = harness();
    const started = await h.manager.start({ goal: 'fail', sessionId: 's1' });
    expect(started.ok).toBe(true);
    h.completions.get('d40')!.resolve({ exitCode: 7, signal: null, stdout: 'partial', stderr: 'boom' });
    await settle();

    const complete = h.bus.history().find(event => event.type === 'agent.subagent' && event.payload.phase === 'complete');
    expect(complete?.payload).toMatchObject({ status: 'failed', output: 'partial', error: 'boom' });
    expect(h.bus.history().filter(event => event.type === 'run.final')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'failed', error: 'boom' }) }),
    ]);
  });

  it('stops one task through fence, terminate and cleanup; late close cannot emit another final', async () => {
    const h = harness();
    await h.manager.start({ goal: 'slow', sessionId: 's1' });
    const stopped = await h.manager.stop('d40');

    expect(stopped).toMatchObject({ ok: true, taskId: 'd40', status: 'cancelled' });
    expect(h.order).toEqual([
      'add:d40',
      'start:d40',
      'fence:delegate:d40',
      'terminate:d40',
      'remove:d40',
    ]);
    h.completions.get('d40')!.resolve({ exitCode: 0, signal: null, stdout: 'late', stderr: '' });
    await settle();
    const finals = h.bus.history().filter(event => event.type === 'run.final');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload.status).toBe('cancelled');
  });

  it('times out with physical termination and exactly one failed final', async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 25 });
    await h.manager.start({ goal: 'hang', sessionId: 's1' });
    await vi.advanceTimersByTimeAsync(25);
    await Promise.resolve();

    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.order).toContain('terminate:d40');
    const finals = h.bus.history().filter(event => event.type === 'run.final');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload).toMatchObject({ status: 'failed', error: '执行超时（25ms）' });
  });

  it('shutdown cancels every active task and pause rejects only new starts', async () => {
    const h = harness();
    await h.manager.start({ goal: 'one', sessionId: 's1' });
    await h.manager.start({ goal: 'two', sessionId: 's2' });
    h.manager.setPaused(true);
    expect(await h.manager.start({ goal: 'three', sessionId: 's3' })).toMatchObject({
      ok: false,
      error: { code: 'SUBAGENT_DELEGATION_PAUSED' },
    });
    expect(h.manager.listActive()).toHaveLength(2);

    await h.manager.shutdown('test');
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toHaveLength(2);
    expect(h.bus.history().filter(event => event.type === 'run.final').map(event => event.payload.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('retains cleanup ownership until a later stop retries successfully', async () => {
    let cleanupOk = false;
    const h = harness({ get cleanupOk() { return cleanupOk; } });
    await h.manager.start({ goal: 'cleanup', sessionId: 's1' });
    const first = await h.manager.stop('d40');

    expect(first).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('WORKTREE_REMOVE_FAILED') });
    expect(h.manager.listActive()).toEqual([expect.objectContaining({ taskId: 'd40', status: 'cleanup_failed' })]);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toHaveLength(0);

    cleanupOk = true;
    const retried = await h.manager.stop('d40');
    expect(retried).toMatchObject({ ok: false, status: 'failed' });
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'failed', error: expect.stringContaining('WORKTREE_REMOVE_FAILED') }) }),
    ]);
  });

  it('terminates and finalizes a process launched while its parent is cancelled', async () => {
    const gate = deferred<void>();
    const h = harness({ launchGate: gate.promise });
    const controller = new AbortController();
    const starting = h.manager.start({ goal: 'cancel during launch', sessionId: 's1', signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    gate.resolve();

    expect(await starting).toMatchObject({ ok: false, error: { code: 'SUBAGENT_ABORTED' } });
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.order).toEqual([
      'add:d40',
      'start:d40',
      'fence:delegate:d40',
      'terminate:d40',
      'remove:d40',
    ]);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'cancelled' }) }),
    ]);
  });

  it('shutdown waits for an in-flight launch, then closes future admission', async () => {
    const gate = deferred<void>();
    const h = harness({ launchGate: gate.promise });
    const starting = h.manager.start({ goal: 'launching', sessionId: 's1' });
    await Promise.resolve();
    let shutdownDone = false;
    const shutdown = h.manager.shutdown('race').then(() => { shutdownDone = true; });
    await Promise.resolve();
    expect(shutdownDone).toBe(false);

    gate.resolve();
    expect(await starting).toMatchObject({ ok: false, error: { code: 'SUBAGENT_MANAGER_CLOSED' } });
    await shutdown;
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.order).toEqual([
      'add:d40',
      'start:d40',
      'fence:delegate:d40',
      'terminate:d40',
      'remove:d40',
    ]);
    expect(await h.manager.start({ goal: 'too late', sessionId: 's2' })).toMatchObject({
      ok: false,
      error: { code: 'SUBAGENT_MANAGER_CLOSED' },
    });
  });

  it('shutdown retries retained cleanup ownership after a failed attempt', async () => {
    let cleanupOk = false;
    const h = harness({ get cleanupOk() { return cleanupOk; } });
    await h.manager.start({ goal: 'cleanup during shutdown', sessionId: 's1' });

    await expect(h.manager.shutdown('first')).rejects.toThrow('SUBAGENT_SHUTDOWN_INCOMPLETE:d40');
    expect(h.manager.listActive()).toEqual([expect.objectContaining({ taskId: 'd40', status: 'cleanup_failed' })]);

    cleanupOk = true;
    await expect(h.manager.shutdown('retry')).resolves.toBeUndefined();
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toHaveLength(1);
  });

  it('retains lifecycle ownership when physical termination fails', async () => {
    const h = harness({ terminateOk: false });
    await h.manager.start({ goal: 'stubborn', sessionId: 's1' });
    const stopped = await h.manager.stop('d40');

    expect(stopped).toMatchObject({ ok: false, status: 'failed', error: 'SUBAGENT_STOP_FAILED' });
    expect(h.manager.listActive()).toEqual([expect.objectContaining({ taskId: 'd40', status: 'stopping' })]);
    expect(h.order).not.toContain('remove:d40');
    expect(h.bus.history().filter(event => event.type === 'run.final')).toHaveLength(0);
  });

  it('finalizes the requested stop when a failed termination is followed by a late process exit', async () => {
    const h = harness({ terminateOk: false });
    await h.manager.start({ goal: 'stubborn', sessionId: 's1' });
    expect(await h.manager.stop('d40')).toMatchObject({ ok: false, error: 'SUBAGENT_STOP_FAILED' });

    h.completions.get('d40')!.resolve({ exitCode: 1, signal: 'SIGKILL', stdout: '', stderr: '' });
    await settle();

    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.order).toContain('remove:d40');
    expect(h.bus.history().filter(event => event.type === 'run.final')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'cancelled', error: '用户终止' }) }),
    ]);
  });
});
