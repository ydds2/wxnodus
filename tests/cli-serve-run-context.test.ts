// tests/cli-serve-run-context.test.ts — P0-2 HTTP Run 隔离、稳定身份与 SSE 过滤
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createSessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import { createInMemoryServeSessionOwnershipStore, startServeServer, type ServeKernel } from '../src/cli/serve.js';
import { createEventBus } from '../src/kernel/events.js';

const PORT = 4796;
const TOKEN = 'serve-run-context-token';
const OTHER_TOKEN = 'serve-run-context-other-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const otherAuth = { Authorization: `Bearer ${OTHER_TOKEN}` };
let dir: string;
let db: ReturnType<typeof openDB>;
let srv: ReturnType<typeof startServeServer>;
let sessionId = 'home';
let active = 0;
let maxActive = 0;
const observed: string[] = [];
const recallSessions: string[] = [];
let bus: ReturnType<typeof createEventBus>;
let coordinator: ReturnType<typeof createSessionRunCoordinator>;
let kernel: ServeKernel;
let aborts = 0;
const commandCalls: string[] = [];
let commandAborts = 0;
const commandGates = new Map<string, RunGate>();
type RunGate = {
  entered: Promise<void>;
  enter(): void;
  wait: Promise<void>;
  release(): void;
};
const runGates = new Map<string, RunGate>();

function createGate(prompt: string): RunGate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const gate = { entered, enter, wait, release };
  runGates.set(prompt, gate);
  return gate;
}

function createCommandGate(command: string): RunGate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const gate = { entered, enter, wait, release };
  commandGates.set(command, gate);
  return gate;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-serve-run-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  const agent = {
    getSessionId: () => sessionId,
    setSessionId: (id: string) => { sessionId = id; },
    abort: () => { aborts += 1; },
    run: async (prompt: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      observed.push(`${prompt}:${sessionId}`);
      bus.emit('agent.token', { text: prompt });
      const gate = runGates.get(prompt);
      gate?.enter();
      if (gate) await gate.wait;
      else await sleep(prompt === 'first' ? 40 : 5);
      active -= 1;
      return { ok: true, text: `reply:${prompt}:${sessionId}`, turns: 1, interrupted: false };
    },
  };
  coordinator = createSessionRunCoordinator({ agent, bus });
  const commandBus = {
    execute: async (command: string, execution: { signal?: AbortSignal } = {}) => {
      commandCalls.push(command);
      if (command === '/resume next-session') agent.setSessionId('next-session');
      if (command === '/resume foreign-session') agent.setSessionId('foreign-session');
      if (command === '/resume Foreign') agent.setSessionId('foreign-session');
      if (command === '/new') agent.setSessionId('new-session');
      if (command === '/mutate-session') agent.setSessionId('incidental-session');
      const gate = commandGates.get(command);
      if (gate) {
        gate.enter();
        await Promise.race([
          gate.wait,
          new Promise<void>(resolve => execution.signal?.addEventListener('abort', () => {
            commandAborts += 1;
            resolve();
          }, { once: true })),
        ]);
      }
      return execution.signal?.aborted
        ? { ok: false, type: 'exec' as const, error: 'cancelled', completionStatus: 'cancelled' as const }
        : { ok: true, type: 'exec' as const, output: command, completionStatus: 'succeeded' as const };
    },
  };
  const runInvocation = createRunInvocationPort({
    coordinator,
    agent,
    executeCommand: (input, context) => commandBus.execute(input, context),
  });
  kernel = {
    dataDir: dir,
    cwd: dir,
    db,
    bus,
    runInvocation,
    mem: {
      recall: () => [],
      recallHybrid: async (_query, options) => {
        recallSessions.push(String(options?.sessionId));
        return [];
      },
    },
    agent,
    commandBus,
    config: { get: () => ({ model: 'mock' }) },
  };
  srv = startServeServer(kernel, PORT, {
    principals: {
      'principal:a': TOKEN,
      'principal:b': OTHER_TOKEN,
    },
  });
});


afterAll(async () => {
  await srv.close();
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

async function rpcWithAuth(method: string, params: Record<string, unknown>, headers: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() as any };
}

async function chat(params: Record<string, unknown>) {
  return rpcWithAuth('chat', params, auth);
}

async function command(params: Record<string, unknown>) {
  return rpcWithAuth('command', params, auth);
}

function disconnectRpc(method: 'chat' | 'command', params: Record<string, unknown>): ClientRequest {
  const body = JSON.stringify({ method, params });
  const req = httpRequest({
    host: '127.0.0.1',
    port: PORT,
    path: '/rpc',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {});
  req.end(body);
  return req;
}

async function destroyAndWait(req: ClientRequest) {
  const closed = new Promise<void>(resolve => req.once('close', resolve));
  req.destroy();
  await closed;
  await sleep(20);
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      sleep(100).then(() => ({ done: false, value: undefined })),
    ]);
    if (result.value) text += decoder.decode(result.value, { stream: true });
    if (text.includes(needle)) return text;
  }
  throw new Error(`SSE timeout waiting for ${needle}: ${text}`);
}

describe('serve RunContext', () => {
  it('serializes concurrent chat requests and keeps session identity isolated', async () => {
    const first = chat({ prompt: 'first', run_id: 'http-run-a', correlation_id: 'http-corr-a', session_id: 'session-a' });
    const second = chat({ prompt: 'second', run_id: 'http-run-b', correlation_id: 'http-corr-b', session_id: 'session-b' });
    const [a, b] = await Promise.all([first, second]);

    expect(a).toMatchObject({ status: 200, body: { status: 'succeeded', runId: 'http-run-a', correlationId: 'http-corr-a', sessionId: 'session-a' } });
    expect(b).toMatchObject({ status: 200, body: { status: 'succeeded', runId: 'http-run-b', correlationId: 'http-corr-b', sessionId: 'session-b' } });
    expect(observed).toEqual(['first:session-a', 'second:session-b']);
    expect(maxActive).toBe(1);
    expect(sessionId).toBe('home');
    for (const runId of ['http-run-a', 'http-run-b']) {
      expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
    }
  });

  it('rejects an already-used run id and does not emit another final event', async () => {
    const duplicate = await chat({ prompt: 'again', run_id: 'http-run-a', correlation_id: 'new-correlation', session_id: 'session-c' });
    expect(duplicate).toMatchObject({ status: 409, body: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } } });
    expect(bus.history().filter(event => event.type === 'run.final' && event.runId === 'http-run-a')).toHaveLength(1);
  });

  it('filters SSE events by an authorized immutable session identity', async () => {
    const ctrl = new AbortController();
    const response = await fetch(`http://127.0.0.1:${PORT}/events?session_id=session-filtered`, { headers: auth, signal: ctrl.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();

    const wanted = chat({ prompt: 'wanted', run_id: 'http-run-filtered', correlation_id: 'corr-filtered', session_id: 'session-filtered' });
    const other = chat({ prompt: 'other', run_id: 'http-run-other', correlation_id: 'corr-other', session_id: 'session-other' });
    await Promise.all([wanted, other]);
    bus.withinRun({
      runId: 'http-run-other',
      correlationId: 'corr-other',
      sessionId: 'session-filtered',
      actorId: 'principal:a',
      source: 'http',
      admittedAt: Date.now(),
    }, () => bus.emit('agent.token', { text: 'spoofed-session' }));
    const final = chat({ prompt: 'final', run_id: 'http-run-final', correlation_id: 'corr-final', session_id: 'session-filtered' });
    const stream = await readUntil(reader, '"runId":"http-run-final"');
    await final;
    ctrl.abort();

    expect(stream).toContain('event: agent.token');
    expect(stream).toContain('"text":"wanted"');
    expect(stream).toContain('"runId":"http-run-filtered"');
    expect(stream).toContain('event: run.final');
    expect(stream).not.toContain('"text":"other"');
    expect(stream).not.toContain('"runId":"http-run-other"');
    expect(stream).not.toContain('spoofed-session');
  });

  it('preserves /resume and /new session switches and uses the active session by default', async () => {
    sessionId = 'home';
    const resumed = await command({ command: '/resume next-session', run_id: 'command-resume', session_id: 'home' });
    expect(resumed).toMatchObject({
      status: 200,
      body: { status: 'succeeded', sessionId: 'home', activeSessionId: 'next-session' },
    });
    expect(sessionId).toBe('next-session');

    const afterResume = await chat({ prompt: 'after-resume', run_id: 'chat-after-resume' });
    expect(afterResume).toMatchObject({ status: 200, body: { sessionId: 'next-session' } });
    expect(observed).toContain('after-resume:next-session');
    expect(sessionId).toBe('next-session');

    const created = await command({ command: '/new', run_id: 'command-new' });
    expect(created).toMatchObject({
      status: 200,
      body: { status: 'succeeded', sessionId: 'next-session', activeSessionId: 'new-session' },
    });
    expect(sessionId).toBe('new-session');

    const ordinary = await command({ command: '/status', run_id: 'command-ordinary', session_id: 'temporary-session' });
    expect(ordinary).toMatchObject({
      status: 200,
      body: { sessionId: 'temporary-session', activeSessionId: 'new-session' },
    });
    expect(sessionId).toBe('new-session');

    const incidental = await command({ command: '/mutate-session', run_id: 'command-incidental', session_id: 'temporary-session' });
    expect(incidental).toMatchObject({
      status: 403,
      body: { error: { code: 'SERVE_COMMAND_FORBIDDEN' } },
    });
    expect(sessionId).toBe('new-session');
    expect(commandCalls).toEqual(expect.arrayContaining(['/resume next-session', '/new', '/status']));
    expect(commandCalls).not.toContain('/mutate-session');
  });

  it('cancels queued chat and command requests when their clients disconnect', async () => {
    const blockerGate = createGate('disconnect-blocker');
    const blocker = chat({ prompt: 'disconnect-blocker', run_id: 'disconnect-blocker', session_id: 'session-blocker' });
    await blockerGate.entered;

    const queuedChat = disconnectRpc('chat', { prompt: 'never-chat', run_id: 'disconnect-queued-chat', session_id: 'session-chat' });
    await waitFor(() => coordinator.has('disconnect-queued-chat'), 'queued chat admission');
    await destroyAndWait(queuedChat);

    const queuedCommand = disconnectRpc('command', { command: '/status', run_id: 'disconnect-queued-command', session_id: 'session-command' });
    await waitFor(() => coordinator.has('disconnect-queued-command'), 'queued command admission');
    await destroyAndWait(queuedCommand);

    blockerGate.release();
    await expect(blocker).resolves.toMatchObject({ status: 200 });
    await waitFor(() => bus.history().some(event => event.type === 'run.final' && event.runId === 'disconnect-queued-command'), 'queued disconnect finals');

    expect(observed).not.toContain('never-chat:session-chat');
    expect(commandCalls).not.toContain('/never-command');
    for (const runId of ['disconnect-queued-chat', 'disconnect-queued-command']) {
      const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === runId);
      expect(finals).toHaveLength(1);
      expect(finals[0]?.payload).toMatchObject({ status: 'cancelled' });
    }
  });

  it('cancels an active chat once when its client disconnects', async () => {
    const gate = createGate('disconnect-active');
    const beforeAborts = aborts;
    const request = disconnectRpc('chat', { prompt: 'disconnect-active', run_id: 'disconnect-active', session_id: 'session-active' });
    await gate.entered;
    await destroyAndWait(request);
    await waitFor(() => aborts === beforeAborts + 1, 'active agent abort');
    gate.release();
    await waitFor(() => bus.history().some(event => event.type === 'run.final' && event.runId === 'disconnect-active'), 'active disconnect final');

    const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === 'disconnect-active');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload).toMatchObject({ status: 'cancelled' });
  });

  it('cancels an active command through its execution signal', async () => {
    const gate = createCommandGate('/status');
    const beforeAborts = commandAborts;
    const request = disconnectRpc('command', { command: '/status', run_id: 'disconnect-active-command', session_id: 'session-command-active' });
    await gate.entered;
    await destroyAndWait(request);
    await waitFor(() => commandAborts === beforeAborts + 1, 'active command abort');
    await waitFor(() => bus.history().some(event => event.type === 'run.final' && event.runId === 'disconnect-active-command'), 'active command final');

    const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === 'disconnect-active-command');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload).toMatchObject({ status: 'cancelled' });
  });

  it('requires idempotency identity for mutating RPCs', async () => {
    const missing = await rpcWithAuth('chat', { prompt: 'missing-id', session_id: 'session-missing-id' }, auth);
    expect(missing).toMatchObject({ status: 400, body: { ok: false, error: { code: 'REQUEST_ID_REQUIRED' } } });
    expect(observed.some(entry => entry.startsWith('missing-id:'))).toBe(false);
  });

  it('isolates session ownership and principal-local defaults', async () => {
    const a = await chat({ prompt: 'owner-a', request_id: 'owner-a-request', session_id: 'owned-by-a' });
    expect(a).toMatchObject({ status: 200, body: { sessionId: 'owned-by-a' } });

    const foreign = await rpcWithAuth('memory.recall', { session_id: 'owned-by-a' }, otherAuth);
    expect(foreign).toMatchObject({ status: 403, body: { ok: false, error: { code: 'SESSION_FORBIDDEN' } } });

    const b = await rpcWithAuth('chat', {
      prompt: 'owner-b', request_id: 'owner-b-request', session_id: 'owned-by-b',
    }, otherAuth);
    expect(b).toMatchObject({ status: 200, body: { sessionId: 'owned-by-b' } });

    const aDefault = await chat({ prompt: 'default-a', request_id: 'default-a-request' });
    const bDefault = await rpcWithAuth('chat', { prompt: 'default-b', request_id: 'default-b-request' }, otherAuth);
    expect(aDefault.body.sessionId).toBe('new-session');
    expect(bDefault.body.sessionId).toBe('owned-by-b');
  });

  it('denies title-resolved foreign resume and global session command surfaces before admission', async () => {
    db.prepare('INSERT OR IGNORE INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('foreign-session', 'Foreign Project', 1, 100);
    const claimed = await rpcWithAuth('memory.recall', { session_id: 'foreign-session' }, otherAuth);
    expect(claimed.status).toBe(200);

    const before = commandCalls.length;
    const resume = await command({
      command: '/resume Foreign', request_id: 'command-resume-foreign', session_id: 'owned-by-a',
    });
    const sessions = await command({
      command: '/sessions', request_id: 'command-sessions-denied', session_id: 'owned-by-a',
    });
    const share = await command({
      command: '/share export foreign-session', request_id: 'command-share-denied', session_id: 'owned-by-a',
    });
    const colonResume = await command({
      command: '/resume:foreign-session', request_id: 'command-colon-resume-denied', session_id: 'owned-by-a',
    });
    const sql = await command({
      command: '/sql SELECT * FROM messages', request_id: 'command-sql-denied', session_id: 'owned-by-a',
    });
    const fork = await command({
      command: '/fork foreign-session', request_id: 'command-fork-denied', session_id: 'owned-by-a',
    });
    const exported = await command({
      command: '/export --jsonl foreign-session', request_id: 'command-export-denied', session_id: 'owned-by-a',
    });
    const stream = await command({
      command: '/session-stream show foreign-session', request_id: 'command-stream-denied', session_id: 'owned-by-a',
    });

    expect(resume).toMatchObject({ status: 403, body: { error: { code: 'SESSION_FORBIDDEN' } } });
    for (const denied of [sessions, share, colonResume, sql, fork, exported, stream]) {
      expect(denied).toMatchObject({ status: 403, body: { error: { code: 'SERVE_COMMAND_FORBIDDEN' } } });
    }
    expect(commandCalls).toHaveLength(before);
  });

  it('fails the Run when a session switch cannot persist principal ownership', async () => {
    const port = 4898;
    const store = createInMemoryServeSessionOwnershipStore();
    let defaultWrites = 0;
    const failingStore = {
      ...store,
      setDefault(principalId: string, targetSessionId: string) {
        defaultWrites += 1;
        if (defaultWrites > 1) return false;
        return store.setDefault(principalId, targetSessionId);
      },
    };
    const server = startServeServer(kernel, port, {
      principals: { 'principal:a': TOKEN },
      ownershipStore: failingStore,
    });
    const previousSessionId = sessionId;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          method: 'command',
          params: { command: '/new', request_id: 'ownership-commit-failure', session_id: 'commit-source' },
        }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        ok: false,
        status: 'failed',
        error: 'SERVE_OWNERSHIP_STORE_FAILED',
      });
      const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === 'ownership-commit-failure');
      expect(finals).toHaveLength(1);
      expect(finals[0]?.payload).toMatchObject({ status: 'failed', error: 'SERVE_OWNERSHIP_STORE_FAILED' });
      expect(sessionId).toBe(previousSessionId);
    } finally {
      await server.close();
    }
  });

  it('rolls back the SQLite default switch and normalizes commit exceptions', async () => {
    const port = 4900;
    const isolatedDir = mkdtempSync(join(tmpdir(), 'wxn-serve-ownership-tx-'));
    const isolatedDb = openDB(isolatedDir);
    let defaultAssignments = 0;
    const failingDb: ServeKernel['db'] = {
      prepare(sql: string) {
        const statement = isolatedDb.prepare(sql);
        if (sql.includes('SET is_default=1')) {
          return {
            get: (...args: unknown[]) => statement.get(...args),
            all: (...args: unknown[]) => statement.all(...args),
            run: (...args: unknown[]) => {
              defaultAssignments += 1;
              if (defaultAssignments > 1) throw new Error('injected sqlite failure');
              return statement.run(...args);
            },
          };
        }
        return statement as any;
      },
      transaction: operation => isolatedDb.transaction(operation as any) as any,
    };
    const server = startServeServer({ ...kernel, dataDir: isolatedDir, db: failingDb }, port, {
      principals: { 'principal:transaction': TOKEN },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          method: 'command',
          params: { command: '/new', request_id: 'ownership-transaction-failure', session_id: 'transaction-source' },
        }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        status: 'failed',
        error: 'SERVE_OWNERSHIP_STORE_FAILED',
      });
      expect(isolatedDb.prepare(
        'SELECT session_id FROM serve_session_ownership WHERE principal_id=? AND is_default=1',
      ).get('principal:transaction')).toEqual({ session_id: 'transaction-source' });
      expect(isolatedDb.prepare(
        'SELECT is_default FROM serve_session_ownership WHERE session_id=?',
      ).get('new-session')).not.toEqual({ is_default: 1 });
    } finally {
      await server.close();
      closeDB(isolatedDb);
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('does not publish SSE ownership when coordinator admission rejects a pre-existing Run ID', async () => {
    await coordinator.execute({
      context: {
        runId: 'foreign-channel-run', correlationId: 'foreign-channel-correlation', sessionId: 'foreign-channel-session',
        actorId: 'other-channel', source: 'cli', admittedAt: Date.now(),
      },
      admissionId: `serve:${createHash('sha256').update('principal:a\u0000foreign-channel-run').digest('hex')}`,
      operation: async () => ({ ok: true, interrupted: false }),
      classify: () => 'succeeded',
    });

    const rejected = await chat({
      prompt: 'must-not-run', request_id: 'foreign-channel-request', run_id: 'foreign-channel-run', session_id: 'owned-by-a',
    });
    expect(rejected).toMatchObject({ status: 409, body: { error: { code: 'RUN_ID_CONFLICT' } } });

    const stream = await fetch(`http://127.0.0.1:${PORT}/events?run_id=foreign-channel-run`, { headers: auth });
    expect(stream.status).toBe(403);
    expect(await stream.json()).toMatchObject({ error: { code: 'SSE_NOT_AUTHORIZED' } });
  });

  it('fails closed when the production ownership database errors', async () => {
    const port = 4896;
    let invocations = 0;
    const failingKernel: ServeKernel = {
      ...kernel,
      db: {
        prepare(sql: string) {
          if (sql.includes('serve_session_ownership')) throw new Error('ownership database unavailable');
          return db.prepare(sql) as any;
        },
      },
      runInvocation: {
        ...kernel.runInvocation,
        invoke(request: any) {
          invocations += 1;
          return kernel.runInvocation.invoke(request);
        },
      },
    };
    const server = startServeServer(failingKernel, port, { token: TOKEN });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ method: 'chat', params: { prompt: 'blocked', request_id: 'ownership-db-failure' } }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SERVE_OWNERSHIP_STORE_FAILED' } });
      expect(invocations).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('normalizes ownership failures from session listing', async () => {
    const port = 4901;
    const failingKernel: ServeKernel = {
      ...kernel,
      db: {
        ...db,
        prepare(sql: string) {
          if (sql.includes('serve_session_ownership')) throw new Error('ownership database unavailable');
          return db.prepare(sql) as any;
        },
      },
    };
    const server = startServeServer(failingKernel, port, { token: TOKEN });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ method: 'sessions', params: {} }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'SERVE_OWNERSHIP_STORE_FAILED' },
      });
    } finally {
      await server.close();
    }
  });

  it('bounds completed Run ownership while retaining the newest SSE authorization', async () => {
    const port = 4897;
    const server = startServeServer(kernel, port, {
      principals: { 'principal:a': TOKEN },
      runOwnerLimit: 1,
      runOwnerTtlMs: 60_000,
    });
    const post = (requestId: string) => fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        method: 'chat', params: { prompt: requestId, request_id: requestId, session_id: 'run-owner-bounded' },
      }),
    });
    try {
      expect((await post('run-owner-old')).status).toBe(200);
      expect((await post('run-owner-new')).status).toBe(200);

      const oldStream = await fetch(`http://127.0.0.1:${port}/events?run_id=run-owner-old`, { headers: auth });
      expect(oldStream.status).toBe(403);
      const controller = new AbortController();
      const newestStream = await fetch(`http://127.0.0.1:${port}/events?run_id=run-owner-new`, { headers: auth, signal: controller.signal });
      expect(newestStream.status).toBe(200);
      controller.abort();
    } finally {
      await server.close();
    }
  });

  it('keeps identical public Run IDs independent after ownership eviction', async () => {
    const port = 4899;
    const server = startServeServer(kernel, port, {
      principals: { 'principal:a': TOKEN, 'principal:b': OTHER_TOKEN },
      runOwnerLimit: 0,
      runOwnerTtlMs: 0,
    });
    const post = (token: string, prompt: string) => fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        method: 'chat',
        params: {
          prompt,
          request_id: 'evicted-shared-request',
          run_id: 'evicted-shared-run',
          session_id: token === TOKEN ? 'evicted-owner-a' : 'evicted-owner-b',
        },
      }),
    });
    try {
      const first = await post(TOKEN, 'evicted-a');
      expect(first.status).toBe(200);
      const second = await post(OTHER_TOKEN, 'evicted-b');
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ runId: 'evicted-shared-run', sessionId: 'evicted-owner-b' });
      expect(bus.history().filter(event => event.type === 'run.final' && event.runId === 'evicted-shared-run')).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('shares concurrent and replayed requests, rejects payload conflicts, and scopes IDs by principal', async () => {
    const concurrentGate = createGate('idempotent-concurrent');
    const concurrentParams = {
      prompt: 'idempotent-concurrent', request_id: 'concurrent-request-id', session_id: 'idem-concurrent',
    };
    const concurrentFirst = chat(concurrentParams);
    await concurrentGate.entered;
    const concurrentReplay = chat(concurrentParams);
    concurrentGate.release();
    const [concurrentA, concurrentB] = await Promise.all([concurrentFirst, concurrentReplay]);
    expect(concurrentB).toEqual(concurrentA);
    expect(observed.filter(entry => entry === 'idempotent-concurrent:idem-concurrent')).toHaveLength(1);

    const params = { prompt: 'idempotent-a', request_id: 'shared-request-id', session_id: 'idem-a' };
    const first = await chat(params);
    const replay = await chat(params);
    expect(replay).toEqual(first);
    expect(observed.filter(entry => entry === 'idempotent-a:idem-a')).toHaveLength(1);

    const conflict = await chat({ ...params, prompt: 'changed' });
    expect(conflict).toMatchObject({ status: 409, body: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } } });

    const other = await rpcWithAuth('chat', {
      prompt: 'idempotent-b', request_id: 'shared-request-id', session_id: 'idem-b',
    }, otherAuth);
    expect(other).toMatchObject({ status: 200, body: { sessionId: 'idem-b' } });
  });

  it('scopes hybrid recall and session listings to the authenticated principal', async () => {
    await rpcWithAuth('memory.search', { query: 'private', session_id: 'owned-by-a' }, auth);
    expect(recallSessions.at(-1)).toBe('owned-by-a');

    db.prepare('INSERT OR IGNORE INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('owned-by-a', 'A', 1, 1);
    db.prepare('INSERT OR IGNORE INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('owned-by-b', 'B', 1, 1);
    const sessions = await rpcWithAuth('sessions', {}, auth);
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions.map((row: { id: string }) => row.id)).toContain('owned-by-a');
    expect(sessions.body.sessions.map((row: { id: string }) => row.id)).not.toContain('owned-by-b');
  });

  it('rejects unfiltered and correlation-only SSE subscriptions', async () => {
    const unfiltered = await fetch(`http://127.0.0.1:${PORT}/events`, { headers: auth });
    expect(unfiltered.status).toBe(400);
    expect(await unfiltered.json()).toMatchObject({ error: { code: 'SSE_FILTER_REQUIRED' } });

    const correlationOnly = await fetch(`http://127.0.0.1:${PORT}/events?correlation_id=corr-only`, { headers: auth });
    expect(correlationOnly.status).toBe(403);
    expect(await correlationOnly.json()).toMatchObject({ error: { code: 'SSE_NOT_AUTHORIZED' } });
  });

  it('rejects invalid identities before admitting a Run', async () => {
    const invalid = await chat({ prompt: 'bad', run_id: 'bad id', session_id: 'session' });
    expect(invalid).toMatchObject({ status: 400, body: { ok: false, error: { code: 'RUN_ID_INVALID' } } });
    const invalidSession = await chat({ prompt: 'bad-session', run_id: 'valid-run-invalid-session', session_id: '..' });
    expect(invalidSession).toMatchObject({ status: 400, body: { ok: false, error: { code: 'SESSION_ID_INVALID' } } });
    expect(bus.history().some(event => event.runId === 'bad id')).toBe(false);
    expect(bus.history().some(event => event.runId === 'valid-run-invalid-session')).toBe(false);
  });
});
