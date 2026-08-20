// tests/a2a-handler-run.test.ts — /a2a serve 生产 handler 的 Run 接纳与统一关闭
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/app/CommandBus.js';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import { createSessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';
import type { HandlerCtx } from '../src/commands/handlers.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { createEventBus } from '../src/kernel/events.js';
import { a2aTaskSend } from '../src/kernel/a2a.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wxn-a2a-handler-'));
  dirs.push(dataDir);
  const events = createEventBus(dataDir);
  const commandBus = createCommandBus();
  const calls: Array<{ prompt: string; sessionId: string }> = [];
  let sessionId = 'home';
  const agent = {
    getSessionId: () => sessionId,
    setSessionId: (next: string) => { sessionId = next; },
    setMode() {},
    getMode: () => 'smart',
    steer: () => true,
    abort() {},
    run: async (prompt: string) => {
      calls.push({ prompt, sessionId });
      return { ok: true, text: `a2a:${prompt}`, turns: 1, interrupted: false };
    },
    spawnSubagent: async () => ({ ok: true, output: '', turns: 0 }),
  };
  const runInvocation = createRunInvocationPort({
    coordinator: createSessionRunCoordinator({ agent, bus: events }),
    agent,
    executeCommand: (input, context) => commandBus.execute(input, context),
  });
  const disposers = new Map<string, () => Promise<void> | void>();
  registerExtHandlers(commandBus, {
    dataDir,
    cwd: process.cwd(),
    db: {},
    mem: {},
    bus: events,
    agent,
    commandBus,
    runInvocation,
    registerDisposer: (id: string, dispose: () => Promise<void> | void) => { disposers.set(id, dispose); },
    config: { get: () => ({}), getKey: () => undefined, setKey() {} },
    getModel: () => '',
    getMode: () => 'smart',
    setMode() {},
    setTheme() {},
    getThemeName: () => 'wxnodus',
    requestExit() {},
    clearHistory() {},
    setModel() {},
    openModelPicker() {},
    openSessions() {},
    setThinking() {},
  } as unknown as HandlerCtx);
  return { calls, commandBus, disposers, events };
}

describe('/a2a serve handler Run 生命周期', () => {
  it('任务经 RunInvocationPort 获得独立会话和唯一 final，disposer 停止端点', async () => {
    const h = createHarness();
    const started = await h.commandBus.execute('/a2a serve 0');
    expect(started.ok).toBe(true);
    const url = started.output?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeTruthy();
    expect(h.disposers.has('a2a-server')).toBe(true);

    const task = await a2aTaskSend(url!, 'handler-task', { timeoutMs: 15_000 });
    expect(task).toMatchObject({ ok: true, state: 'completed', text: 'a2a:handler-task' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.sessionId).toMatch(/^a2a-task-/);

    const finals = h.events.history().filter(event => event.type === 'run.final');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      sessionId: h.calls[0]?.sessionId,
      payload: { status: 'succeeded' },
    });

    await h.disposers.get('a2a-server')?.();
    await expect(fetch(url!, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  });
});
