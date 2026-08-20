// tests/cli-serve-protocol.test.ts — supremacy 2.5：--serve 协议加固（结构化 sessions RPC + session.changed SSE 广播）
// 契约：docs/serve-protocol.md v1。真实 db + 真实 listSessionsStructured（单一事实源）；
// 窄端口回退裸 SQL（诚实降级不崩）；chat/command 后 SSE 收到 session.changed
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createSessionRunCoordinator } from '../src/application/runs/sessionRunCoordinator.js';
import { createRunInvocationPort } from '../src/application/runs/runInvocationPort.js';
import { startServeServer, type ServeKernel } from '../src/cli/serve.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let srv: ReturnType<typeof startServeServer>;
const PORT = 4795;
const TOKEN = 'sup-25-protocol-token';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-serve25-'));
  db = openDB(dir);
  // 种子：带血缘/消息的会话（结构化字段全部有值可断言）
  const seed = db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, forked_from_id) VALUES (?,?,?,?,?)`);
  seed.run('src1', '源头会话', 1000, 2000, null);
  seed.run('fork1', '分支会话', 1000, 3000, 'src1');
  const msg = db.prepare(`INSERT INTO messages (session_id, role, content, archived, ts) VALUES (?,?,?,0,?)`);
  msg.run('src1', 'user', '请帮我做一个待办系统', 1100);
  msg.run('src1', 'assistant', '好的', 1200);
  msg.run('fork1', 'user', '换个思路试试', 3100);
  const bus = createEventBus(dir);
  let sessionId = 'src1';
  const agent = {
    run: async (p: string) => ({ ok: true, text: `回复：${p}`, turns: 1, interrupted: false }),
    getSessionId: () => sessionId,
    setSessionId: (id: string) => { sessionId = id; },
    abort: () => {},
  };
  const runCoordinator = createSessionRunCoordinator({ agent, bus });
  const commandBus = { execute: async (c: string) => ({ ok: true, type: 'exec' as const, output: `执行：${c}` }) };
  const runInvocation = createRunInvocationPort({
    coordinator: runCoordinator,
    agent,
    executeCommand: input => commandBus.execute(input),
  });
  const kernel: ServeKernel = {
    dataDir: dir, cwd: dir, db, bus, runInvocation,
    mem: { recall: () => [], recallHybrid: async () => [] },
    agent,
    commandBus,
    config: { get: () => ({ model: 'mock' }) },
  };
  srv = startServeServer(kernel, PORT, { token: TOKEN });
});
afterAll(async () => { await srv.close(); closeDB(db); rmSync(dir, { recursive: true, force: true }); });

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('serve 协议加固（supremacy 2.5）', () => {
  it('POST /rpc sessions → 结构化行（首问摘要/消息数/分支数/血缘——listSessionsStructured 单一事实源）', async () => {
    for (const sessionId of ['src1', 'fork1']) {
      const claim = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ method: 'memory.recall', params: { session_id: sessionId } }),
      });
      expect(claim.status).toBe(200);
    }
    const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ method: 'sessions', params: {} }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    const src = j.sessions.find((s: any) => s.id === 'src1');
    expect(src).toBeTruthy();
    expect(src.title).toBe('源头会话');
    expect(src.msgCount).toBe(2);
    expect(src.firstUser).toBe('请帮我做一个待办系统');
    expect(src.forkedFromId).toBeNull();
    expect(src.forkCount).toBe(1); // fork1 是其分支
    const fork = j.sessions.find((s: any) => s.id === 'fork1');
    expect(fork.forkedFromId).toBe('src1');
  });

  it('GET /events：chat RPC 完成后广播 session.changed（事件驱动刷新，无轮询）', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${PORT}/events?session_id=src1`, { headers: auth, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let got = '';
    // 触发 chat RPC（广播发生在 RPC 完成后）
    await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ method: 'chat', params: { prompt: '你好', request_id: 'protocol-chat' } }),
    });
    // 读流直到 session.changed（超时 5s 防挂）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value } = await reader.read();
      got += decoder.decode(value ?? new Uint8Array(), { stream: true });
      if (got.includes('event: session.changed')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    ctrl.abort();
    expect(got).toContain('event: ready'); // 连接首事件
    expect(got).toContain('event: session.changed');
    expect(got).toContain('"reason":"chat"');
    expect(got).toContain('src1');
  });

  it('command RPC 完成后同样广播 session.changed', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${PORT}/events?session_id=src1`, { headers: auth, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let got = '';
    // 先触发 command RPC
    await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ method: 'command', params: { command: '/status', request_id: 'protocol-command' } }),
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value } = await reader.read();
      got += decoder.decode(value ?? new Uint8Array(), { stream: true });
      if (got.includes('"reason":"command"')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    ctrl.abort();
    expect(got).toContain('"reason":"command"');
  });
});
