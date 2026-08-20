// tests/kernel-serve.test.ts — AI 网关：HTTP 服务（/health/live /health /rpc /events；Bearer 认证）
import { request } from 'node:http';
import { describe, it, expect, afterAll } from 'vitest';
import { startServeServer, createInMemoryServeSessionOwnershipStore, type ServeKernel } from '../src/cli/serve.js';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import type { RunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import type { SessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';

const runCoordinator: SessionRunCoordinator = {
  has: () => false,
  async execute(request) {
    const value = await request.operation();
    return { context: request.context, status: request.classify(value), value };
  },
};

const agent = { run: async (p: string) => ({ ok: true, text: `回复：${p}`, turns: 1, interrupted: false }) };
const commandBus = { execute: async (c: string) => ({ ok: true, type: 'exec' as const, output: `命令执行：${c}` }) };
const runInvocation = createRunInvocationPort({
  coordinator: runCoordinator,
  agent,
  executeCommand: input => commandBus.execute(input),
});

const kernel: ServeKernel = {
  dataDir: 'C:/tmp/wxn-serve-test',
  cwd: 'C:/tmp',
  db: {
    prepare: () => ({ get: () => ({ c: 42 }), all: () => [{ id: 's1', title: '测试会话', updated_at: 1 }], run: () => ({ changes: 1 }) }),
  },
  bus: { on: () => () => {} },
  runInvocation,
  mem: {
    recallHybrid: async (q) => [{ id: 1, content: `命中：${q}`, score: 1, session_id: 's1' }],
    recall: () => [{ id: 1, role: 'user', content: '你好', ts: 1 }],
  },
  agent,
  commandBus,
  config: { get: () => ({ model: 'deepseek-v4-flash' }) },
};

const PORT = 4792;
const TOKEN = 'kernel-serve-test-token';
const srv = startServeServer(kernel, PORT, { token: TOKEN, ownershipStore: createInMemoryServeSessionOwnershipStore() });

afterAll(async () => { await srv.close(); });

const rpc = async (body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const settlesWithin = async (promise: Promise<unknown>, timeoutMs = 1_000) => {
  const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), timeoutMs));
  return Promise.race([promise.then(() => 'settled' as const), timeout]);
};

const ownershipOptions = () => ({ token: TOKEN, ownershipStore: createInMemoryServeSessionOwnershipStore() });

const lifecycleKernel = (overrides: Partial<ServeKernel>): ServeKernel => ({
  ...kernel,
  ...overrides,
});

describe('AI 网关（wxnodus --serve）', () => {
  it('GET /health/live 返回最小存活状态（无认证、零泄漏）', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health/live`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.service).toBe('wxnodus-serve');
    expect(j).not.toHaveProperty('dataDir');
    expect(j).not.toHaveProperty('model');
  });
  it('GET /health 认证后返回完整服务状态', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.service).toBe('wxnodus-serve');
    expect(j.model).toBe('deepseek-v4-flash');
  });
  it('未携带 token 的 /health、/rpc、/events 一律 401', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/health`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${PORT}/events`)).status).toBe(401);
    const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'command', params: { command: '/status' } }),
    });
    expect(r.status).toBe(401);
  });
  it('POST /rpc chat → agent.run 真实调用', async () => {
    const r = await rpc({ method: 'chat', params: { prompt: '你好', request_id: 'kernel-chat' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.text).toBe('回复：你好');
  });
  it('POST /rpc command → commandBus 真实执行', async () => {
    const r = await rpc({ method: 'command', params: { command: '/status', request_id: 'kernel-command' } });
    expect(r.status).toBe(200);
    expect(r.json.output).toBe('命令执行：/status');
  });
  it('POST /rpc memory.search → 混合召回', async () => {
    const r = await rpc({ method: 'memory.search', params: { query: '密钥', limit: 3 } });
    expect(r.status).toBe(200);
    expect(r.json.hits[0].content).toContain('密钥');
  });
  it('未知 method → 400 明确错误（不静默）', async () => {
    const r = await rpc({ method: 'nope' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('未知 method');
  });
  it('GET /events SSE 连接可建立（认证）', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${PORT}/events?session_id=default`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
  });
});

describe('HTTP serve shutdown lifecycle', () => {
  it('close synchronously fences a partially received RPC before invocation admission', async () => {
    const port = 4892;
    let invocations = 0;
    const runInvocation = {
      invoke() {
        invocations += 1;
        throw new Error('late invocation must not be admitted');
      },
      has: () => false,
    } as unknown as RunInvocationPort;
    const server = startServeServer(lifecycleKernel({ runInvocation }), port, ownershipOptions());
    const body = JSON.stringify({ method: 'chat', params: { prompt: 'late work' } });
    const splitAt = Math.floor(body.length / 2);
    const clientDone = deferred<void>();
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/rpc',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      res.resume();
      res.once('end', () => clientDone.resolve());
    });
    req.once('error', () => clientDone.resolve());

    try {
      req.write(body.slice(0, splitAt));
      await new Promise(resolve => setTimeout(resolve, 20));
      const closing = server.close();
      req.end(body.slice(splitAt));

      expect(await settlesWithin(closing)).toBe('settled');
      expect(invocations).toBe(0);
    } finally {
      req.destroy();
      await Promise.race([clientDone.promise, new Promise(resolve => setTimeout(resolve, 50))]);
      await server.close();
    }
  });

  it('close cancels every active chat and command handle and remains bounded and idempotent', async () => {
    const port = 4893;
    const admissions: Array<{
      kind: 'agent' | 'command';
      completion: { promise: Promise<any>; resolve(value: any): void };
    }> = [];
    const cancellations: string[] = [];
    const runInvocation = {
      invoke(input: { kind: 'agent' | 'command'; runId?: string; correlationId?: string; sessionId?: string }) {
        const completion = deferred<any>();
        admissions.push({ kind: input.kind, completion });
        return {
          context: {
            runId: input.runId ?? `run-${input.kind}`,
            correlationId: input.correlationId ?? `correlation-${input.kind}`,
            sessionId: input.sessionId ?? 'default',
            admittedAt: Date.now(),
          },
          completion: completion.promise,
          cancel: () => { cancellations.push(input.kind); },
        };
      },
      has: () => false,
    } as unknown as RunInvocationPort;
    const server = startServeServer(lifecycleKernel({ runInvocation }), port, {
      token: TOKEN,
      ownershipStore: createInMemoryServeSessionOwnershipStore(),
      shutdownGraceMs: 0,
      shutdownForceMs: 50,
    });
    const abortRequests = new AbortController();
    const post = (method: 'chat' | 'command', params: Record<string, string>) => fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: abortRequests.signal,
    });
    const requests = [
      post('chat', { prompt: 'wait', run_id: 'run-chat' }),
      post('command', { command: '/status', run_id: 'run-command' }),
    ];

    try {
      await waitFor(() => admissions.length === 2);
      const firstClose = server.close();
      const secondClose = server.close();

      await waitFor(() => cancellations.length === 2);
      expect(cancellations.sort()).toEqual(['agent', 'command']);
      expect(await settlesWithin(Promise.all([firstClose, secondClose]))).toBe('settled');
      expect(cancellations.sort()).toEqual(['agent', 'command']);
    } finally {
      for (const admission of admissions) {
        admission.completion.resolve({
          context: { runId: 'cleanup', correlationId: 'cleanup', sessionId: 'default', admittedAt: 0 },
          status: 'cancelled',
        });
      }
      abortRequests.abort();
      await Promise.allSettled(requests);
      await server.close();
    }
  });

  it('close allows admitted work to finish during the grace period before cancellation', async () => {
    const port = 4895;
    const completion = deferred<any>();
    let admitted = false;
    let cancellations = 0;
    const runInvocation = {
      invoke(input: { runId?: string; correlationId?: string; sessionId?: string }) {
        admitted = true;
        return {
          context: {
            runId: input.runId ?? 'grace-run',
            correlationId: input.correlationId ?? 'grace-correlation',
            sessionId: input.sessionId ?? 'default',
            actorId: 'serve:local',
            source: 'http',
            admittedAt: Date.now(),
          },
          completion: completion.promise,
          cancel: () => { cancellations += 1; },
        };
      },
      has: () => false,
    } as unknown as RunInvocationPort;
    const server = startServeServer(lifecycleKernel({ runInvocation }), port, {
      token: TOKEN,
      ownershipStore: createInMemoryServeSessionOwnershipStore(),
      shutdownGraceMs: 100,
      shutdownForceMs: 50,
    });
    const request = fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'chat', params: { prompt: 'finish', request_id: 'grace-run' } }),
    });

    try {
      await waitFor(() => admitted);
      const closing = server.close();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(cancellations).toBe(0);

      completion.resolve({
        context: {
          runId: 'grace-run', correlationId: 'grace-correlation', sessionId: 'default',
          actorId: 'serve:local', source: 'http', admittedAt: 0,
        },
        status: 'succeeded',
        value: { ok: true, text: 'done', turns: 1, interrupted: false },
      });
      await expect(request).resolves.toHaveProperty('status', 200);
      await expect(closing).resolves.toBeUndefined();
      expect(cancellations).toBe(0);
    } finally {
      completion.resolve(undefined);
      await server.close();
    }
  });

  it('close ends an SSE client and unsubscribes every listener without waiting for disconnect', async () => {
    const port = 4894;
    const subscriptions = new Set<string>();
    const unsubscribeCounts = new Map<string, number>();
    const bus = {
      on(type: string) {
        subscriptions.add(type);
        return () => {
          subscriptions.delete(type);
          unsubscribeCounts.set(type, (unsubscribeCounts.get(type) ?? 0) + 1);
        };
      },
    };
    const server = startServeServer(lifecycleKernel({ bus }), port, {
      token: TOKEN,
      ownershipStore: createInMemoryServeSessionOwnershipStore(),
      shutdownGraceMs: 0,
    });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/events?session_id=default`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: controller.signal,
      });
      reader = response.body?.getReader();
      expect(subscriptions.size).toBeGreaterThan(0);

      const firstClose = server.close();
      const secondClose = server.close();
      expect(await settlesWithin(Promise.all([firstClose, secondClose]))).toBe('settled');
      expect(subscriptions.size).toBe(0);
      expect([...unsubscribeCounts.values()].every(count => count === 1)).toBe(true);

      let ended = false;
      while (!ended) {
        const result = await Promise.race([
          reader!.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE did not end')), 250)),
        ]);
        ended = result.done;
      }
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await server.close();
    }
  });
});
