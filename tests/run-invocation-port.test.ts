// tests/run-invocation-port.test.ts — 顶层 Run 接纳、取消与会话所有权契约
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import { createSessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';
import { createEventBus } from '../src/kernel/events.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-run-invoke-'));
  dirs.push(dir);
  const bus = createEventBus(dir);
  let sessionId = 'home';
  let active = 0;
  let maxActive = 0;
  let aborts = 0;
  const calls: string[] = [];
  const agent = {
    getSessionId: () => sessionId,
    setSessionId: (id: string) => { sessionId = id; },
    abort: () => { aborts += 1; },
    run: async (prompt: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(`agent:${prompt}:${sessionId}`);
      await new Promise(resolve => setTimeout(resolve, prompt === 'slow' ? 30 : 5));
      active -= 1;
      return { ok: true, text: prompt, turns: 1, interrupted: false };
    },
  };
  const coordinator = createSessionRunCoordinator({ agent, bus });
  let port!: ReturnType<typeof createRunInvocationPort>;
  port = createRunInvocationPort({
    coordinator,
    agent,
    executeCommand: async (command, context) => {
      calls.push(`command:${command}:${sessionId}`);
      if (command === '/resume next') agent.setSessionId('next');
      if (command === '/nested') {
        await agent.run('nested');
      }
      return context.signal.aborted
        ? { ok: false, completionStatus: 'cancelled' }
        : { ok: true, output: command, completionStatus: 'succeeded' };
    },
  });
  return {
    agent,
    bus,
    calls,
    port,
    getSession: () => sessionId,
    getMaxActive: () => maxActive,
    getAborts: () => aborts,
  };
}

describe('RunInvocationPort', () => {
  it('serializes agent and command admissions with immutable event identity', async () => {
    const h = harness();
    const first = h.port.invoke({ kind: 'agent', prompt: 'slow', runId: 'invoke-agent', correlationId: 'corr-agent', sessionId: 'session-a' });
    const second = h.port.invoke({ kind: 'command', command: '/status', runId: 'invoke-command', correlationId: 'corr-command', sessionId: 'session-b' });

    await Promise.all([first.completion, second.completion]);

    expect(h.calls).toEqual(['agent:slow:session-a', 'command:/status:session-b']);
    expect(h.getMaxActive()).toBe(1);
    expect(h.getSession()).toBe('home');
    for (const handle of [first, second]) {
      expect(Object.isFrozen(handle.context)).toBe(true);
      const finals = h.bus.history().filter(event => event.type === 'run.final' && event.runId === handle.context.runId);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toMatchObject({
        runId: handle.context.runId,
        correlationId: handle.context.correlationId,
        sessionId: handle.context.sessionId,
      });
    }
  });

  it('samples the active session at admission and preserves only session commands', async () => {
    const h = harness();
    const first = h.port.invoke({ kind: 'command', command: '/resume next', runId: 'invoke-resume' });
    expect(first.context.sessionId).toBe('home');
    await expect(first.completion).resolves.toMatchObject({ status: 'succeeded', activeSessionId: 'next' });
    expect(h.getSession()).toBe('next');

    const second = h.port.invoke({ kind: 'agent', prompt: 'after', runId: 'invoke-after' });
    expect(second.context.sessionId).toBe('next');
    await second.completion;
    expect(h.getSession()).toBe('next');
  });

  it('combines caller cancellation with a handle-scoped cancel operation', async () => {
    const h = harness();
    const caller = new AbortController();
    caller.abort();
    const queued = h.port.invoke({ kind: 'agent', prompt: 'never', runId: 'invoke-pre-cancel', signal: caller.signal });
    await expect(queued.completion).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.calls).not.toContain(expect.stringContaining('never'));

    const active = h.port.invoke({ kind: 'agent', prompt: 'slow', runId: 'invoke-active-cancel' });
    await new Promise(resolve => setTimeout(resolve, 5));
    active.cancel();
    await expect(active.completion).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.getAborts()).toBe(1);
  });

  it('allows nested raw Agent work without reacquiring the coordinator', async () => {
    const h = harness();
    const handle = h.port.invoke({ kind: 'command', command: '/nested', runId: 'invoke-nested', sessionId: 'session-nested' });
    await expect(handle.completion).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.calls).toEqual(['command:/nested:session-nested', 'agent:nested:session-nested']);
    expect(h.bus.history().filter(event => event.type === 'run.final' && event.runId === 'invoke-nested')).toHaveLength(1);
  });

  it('admits session operations, classifies once, and preserves only successful target changes', async () => {
    const h = harness();
    let classifications = 0;
    const success = h.port.invoke({
      kind: 'session',
      runId: 'invoke-session-success',
      sessionId: 'home',
      targetSessionId: 'created',
      operation: async () => ({ ok: true }),
      classify: value => {
        classifications += 1;
        return value.ok ? 'succeeded' : 'failed';
      },
    });
    await expect(success.completion).resolves.toMatchObject({ status: 'succeeded', activeSessionId: 'created' });
    expect(classifications).toBe(1);
    expect(h.getSession()).toBe('created');

    const failed = h.port.invoke({
      kind: 'session',
      runId: 'invoke-session-failed',
      sessionId: 'created',
      targetSessionId: 'rejected',
      operation: async () => ({ ok: false }),
      classify: value => value.ok ? 'succeeded' : 'failed',
    });
    await expect(failed.completion).resolves.toMatchObject({ status: 'failed', activeSessionId: 'created' });
    expect(h.getSession()).toBe('created');
    for (const runId of ['invoke-session-success', 'invoke-session-failed']) {
      expect(h.bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
    }
  });

  it('cancels a queued session operation before side effects and still finalizes once', async () => {
    const h = harness();
    const blocker = h.port.invoke({ kind: 'agent', prompt: 'slow', runId: 'invoke-session-blocker' });
    let operated = false;
    const queued = h.port.invoke({
      kind: 'session',
      runId: 'invoke-session-queued-cancel',
      sessionId: 'home',
      targetSessionId: 'never',
      operation: async () => {
        operated = true;
        return { ok: true };
      },
      classify: value => value.ok ? 'succeeded' : 'failed',
    });
    queued.cancel();

    await Promise.all([blocker.completion, queued.completion]);
    expect(operated).toBe(false);
    expect(h.getSession()).toBe('home');
    const finals = h.bus.history().filter(event => event.type === 'run.final' && event.runId === queued.context.runId);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload?.status).toBe('cancelled');
  });
});
