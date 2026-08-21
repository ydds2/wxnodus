// tests/legacy-gateway-run.test.ts — legacy /gateway 的 Run 身份、断连与停服生命周期
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/app/CommandBus.js';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import { createSessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { createEventBus } from '../src/kernel/events.js';
import type { HandlerCtx } from '../src/commands/handlers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('wait timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

function createHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wxn-legacy-gateway-'));
  dirs.push(dataDir);
  const events = createEventBus(dataDir);
  const commandBus = createCommandBus();
  const calls: Array<{ prompt: string; sessionId: string }> = [];
  const releases = new Map<string, () => void>();
  let sessionId = 'home';
  let aborts = 0;
  const agent = {
    getSessionId: () => sessionId,
    setSessionId: (next: string) => { sessionId = next; },
    setMode() {},
    getMode: () => 'smart',
    steer: () => true,
    abort: () => {
      aborts++;
      for (const release of [...releases.values()]) release();
    },
    run: async (prompt: string) => {
      calls.push({ prompt, sessionId });
      if (prompt.startsWith('slow-')) {
        await new Promise<void>(resolve => {
          releases.set(prompt, () => {
            releases.delete(prompt);
            resolve();
          });
        });
      }
      return { ok: true, text: `reply:${prompt}`, turns: 1, interrupted: false };
    },
    spawnSubagent: async () => ({ ok: true, output: '', turns: 0 }),
  };
  commandBus.register('/probe', () => 'probe-ok');
  const runInvocation = createRunInvocationPort({
    coordinator: createSessionRunCoordinator({ agent, bus: events }),
    agent,
    executeCommand: (input, context) => commandBus.execute(input, context),
  });
  const disposers = new Map<string, () => Promise<void> | void>();
  const ctx = {
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
  } as unknown as HandlerCtx;
  registerExtHandlers(commandBus, ctx);

  let url = '';
  let token = '';
  return {
    calls,
    events,
    getAborts: () => aborts,
    release: (prompt: string) => releases.get(prompt)?.(),
    async start() {
      const result = await commandBus.execute('/gateway start 0');
      expect(result.ok).toBe(true);
      const match = result.output?.match(/http:\/\/127\.0\.0\.1:\d+/);
      expect(match?.[0]).toBeTruthy();
      url = `${match![0]}/rpc`;
      // V4 P0-7：/gateway 现需 Bearer——从启动输出解析一次性令牌
      token = result.output?.match(/令牌[^：]*：([0-9a-f]{16,})/)?.[1] ?? '';
    },
    async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, params }),
        signal,
      });
      return response.json() as Promise<any>;
    },
    disconnect(method: string, params: Record<string, unknown>) {
      const target = new URL(url);
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      request.on('error', () => {});
      request.end(JSON.stringify({ method, params }));
      return request;
    },
    async dispose() {
      await disposers.get('legacy-gateway')?.();
    },
    async stop() {
      return commandBus.execute('/gateway stop');
    },
  };
}

describe('legacy /gateway Run 生命周期', () => {
  it('prompt 与 command 各自获得独立 Run，并返回标准终态和唯一 final', async () => {
    const h = createHarness();
    await h.start();
    try {
      const prompt = await h.rpc('prompt', { text: 'hello', session_id: 'gateway-prompt' });
      const command = await h.rpc('command', { input: '/probe', session_id: 'gateway-command' });
      const failed = await h.rpc('command', { input: '/missing', session_id: 'gateway-failed' });

      expect(prompt).toMatchObject({ ok: true, status: 'succeeded', text: 'reply:hello', turns: 1 });
      expect(command).toMatchObject({ ok: true, status: 'succeeded', output: 'probe-ok' });
      expect(failed).toMatchObject({ ok: false, status: 'failed' });
      expect(new Set([prompt.run_id, command.run_id, failed.run_id]).size).toBe(3);

      for (const response of [prompt, command, failed]) {
        const finals = h.events.history().filter(event => event.type === 'run.final' && event.runId === response.run_id);
        expect(finals).toHaveLength(1);
        expect(finals[0]?.payload.status).toBe(response.status);
      }
      expect(h.calls).toEqual([{ prompt: 'hello', sessionId: 'gateway-prompt' }]);
    } finally {
      await h.stop();
    }
  });

  it('排队请求断连只取消匹配 Run，不中止当前活动 Run', async () => {
    const h = createHarness();
    await h.start();
    try {
      const active = h.rpc('prompt', { text: 'slow-active', session_id: 'gateway-active' });
      await waitFor(() => h.calls.some(call => call.prompt === 'slow-active'));

      const queued = h.disconnect('prompt', {
        text: 'slow-queued',
        session_id: 'gateway-queued',
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      queued.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(h.getAborts()).toBe(0);
      h.release('slow-active');
      await expect(active).resolves.toMatchObject({ status: 'succeeded' });
      await waitFor(() => h.events.history().some(event => event.type === 'run.final' && event.sessionId === 'gateway-queued'));

      expect(h.calls.some(call => call.prompt === 'slow-queued')).toBe(false);
      const activeFinals = h.events.history().filter(event => event.type === 'run.final' && event.sessionId === 'gateway-active');
      const queuedFinals = h.events.history().filter(event => event.type === 'run.final' && event.sessionId === 'gateway-queued');
      expect(activeFinals).toHaveLength(1);
      expect(activeFinals[0]?.payload.status).toBe('succeeded');
      expect(queuedFinals).toHaveLength(1);
      expect(queuedFinals[0]?.payload.status).toBe('cancelled');
    } finally {
      await h.stop();
    }
  });

  it('统一 disposer 取消活动请求并等待其唯一 cancelled 终态', async () => {
    const h = createHarness();
    await h.start();
    const request = h.rpc('prompt', { text: 'slow-stop', session_id: 'gateway-stop' });
    await waitFor(() => h.calls.some(call => call.prompt === 'slow-stop'));

    await h.dispose();
    await expect(request).resolves.toMatchObject({ ok: false, status: 'cancelled' });
    expect(h.getAborts()).toBe(1);

    const finals = h.events.history().filter(event => event.type === 'run.final' && event.sessionId === 'gateway-stop');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload.status).toBe('cancelled');
  });
});
