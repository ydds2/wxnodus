import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/app/CommandBus.js';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import { createSessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { closeDB, openDB } from '../src/store/db.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(run: (prompt: string, options?: {
  signal?: AbortSignal;
  images?: Array<{ dataUrl: string; mime: string }>;
  goalLoop?: boolean;
}) => Promise<{
  ok: boolean;
  text: string;
  turns: number;
  interrupted: boolean;
  status?: string;
}>) {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-flow-run-'));
  const db = openDB(dir);
  cleanups.push(() => {
    closeDB(db);
    rmSync(dir, { recursive: true, force: true });
  });
  const eventBus = createEventBus(dir);
  const commandBus = createCommandBus();
  let sessionId = 'home';
  const agent = {
    run,
    spawnSubagent: async () => ({ ok: true, output: '', turns: 0 }),
    abort: () => undefined,
    setMode: () => undefined,
    getMode: () => 'smart',
    setSessionId: (id: string) => { sessionId = id; },
    getSessionId: () => sessionId,
  };
  registerExtHandlers(commandBus, {
    dataDir: dir,
    cwd: process.cwd(),
    db,
    mem: createMemory(db),
    bus: eventBus,
    config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined },
    agent,
    getModel: () => '',
    getMode: () => 'smart',
    setMode: () => undefined,
    setTheme: () => undefined,
    getThemeName: () => 'wxnodus',
    requestExit: () => undefined,
    clearHistory: () => undefined,
    setModel: () => undefined,
    openModelPicker: () => undefined,
    openSessions: () => undefined,
    setThinking: () => undefined,
  } as any);
  const coordinator = createSessionRunCoordinator({ agent, bus: eventBus });
  const port = createRunInvocationPort({
    coordinator,
    agent,
    executeCommand: (input, context) => commandBus.execute(input, context),
  });
  const nodes = [
    { name: 'prepare', instruction: 'prepare' },
    { name: 'build', instruction: 'build' },
  ];
  const result = db.prepare(
    `INSERT INTO flow_runs (skill, nodes, current, finished, ts) VALUES (?,?,?,?,?)`,
  ).run('demo', JSON.stringify(nodes), 0, 0, Date.now());
  const flowId = Number(result.lastInsertRowid);
  const current = () => (db.prepare(`SELECT current FROM flow_runs WHERE id=?`).get(flowId) as { current: number }).current;
  const finals = (runId: string) => eventBus.history().filter(event => event.type === 'run.final' && event.runId === runId);
  return { current, eventBus, finals, port };
}

describe('/flow Run lifecycle', () => {
  it('awaits Agent completion before advancing the cursor and finalizing', async () => {
    const release = deferred<{ ok: boolean; text: string; turns: number; interrupted: boolean }>();
    const started = deferred<void>();
    const h = harness(async () => {
      h.eventBus.emit('agent.message', { text: 'step output' });
      started.resolve();
      return release.promise;
    });
    const handle = h.port.invoke({ kind: 'command', command: '/flow next', runId: 'flow-success' });
    await started.promise;

    expect(h.current()).toBe(0);
    expect(h.finals(handle.context.runId)).toHaveLength(0);

    release.resolve({ ok: true, text: 'done', turns: 1, interrupted: false });
    await expect(handle.completion).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.current()).toBe(1);
    expect(h.finals(handle.context.runId)).toHaveLength(1);

    const events = h.eventBus.history().filter(event => event.runId === handle.context.runId);
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['agent.message', 'run.final']));
    expect(events.findIndex(event => event.type === 'agent.message'))
      .toBeLessThan(events.findIndex(event => event.type === 'run.final'));
  });

  it('does not advance the cursor when nested Agent work fails', async () => {
    const h = harness(async () => ({
      ok: false,
      text: 'failed step',
      turns: 1,
      interrupted: false,
      status: 'failed',
    }));
    const handle = h.port.invoke({ kind: 'command', command: '/flow next', runId: 'flow-failed' });

    await expect(handle.completion).resolves.toMatchObject({
      status: 'failed',
      value: { ok: false, completionStatus: 'failed' },
    });
    expect(h.current()).toBe(0);
    expect(h.finals(handle.context.runId)).toHaveLength(1);
  });

  it('propagates handle cancellation and leaves the cursor unchanged', async () => {
    const started = deferred<void>();
    const h = harness((_prompt, options) => new Promise(resolve => {
      started.resolve();
      const finish = () => resolve({
        ok: false,
        text: 'cancelled step',
        turns: 0,
        interrupted: true,
        status: 'cancelled',
      });
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener('abort', finish, { once: true });
    }));
    const handle = h.port.invoke({ kind: 'command', command: '/flow next', runId: 'flow-cancelled' });
    await started.promise;
    handle.cancel();

    await expect(handle.completion).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.current()).toBe(0);
    expect(h.finals(handle.context.runId)).toHaveLength(1);
    expect(h.finals(handle.context.runId)[0]?.payload).toMatchObject({ status: 'cancelled' });
  });
});
