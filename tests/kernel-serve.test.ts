// tests/kernel-serve.test.ts — AI 网关：HTTP 服务（/health/live /health /rpc /events；Bearer 认证）
import { describe, it, expect, afterAll } from 'vitest';
import { startServeServer, type ServeKernel } from '../src/cli/serve.js';

const kernel: ServeKernel = {
  dataDir: 'C:/tmp/wxn-serve-test',
  cwd: 'C:/tmp',
  db: {
    prepare: () => ({ get: () => ({ c: 42 }), all: () => [{ id: 's1', title: '测试会话', updated_at: 1 }], run: () => ({ changes: 1 }) }),
  },
  bus: { on: () => () => {} },
  mem: {
    recallHybrid: async (q) => [{ id: 1, content: `命中：${q}`, score: 1, session_id: 's1' }],
    recall: () => [{ id: 1, role: 'user', content: '你好', ts: 1 }],
  },
  agent: { run: async (p) => ({ ok: true, text: `回复：${p}`, turns: 1, interrupted: false }) },
  commandBus: { execute: async (c) => ({ ok: true, output: `命令执行：${c}` }) },
  config: { get: () => ({ model: 'deepseek-v4-flash' }) },
};

const PORT = 4792;
const TOKEN = 'kernel-serve-test-token';
const srv = startServeServer(kernel, PORT, { token: TOKEN });

afterAll(async () => { await srv.close(); });

const rpc = async (body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

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
    const r = await rpc({ method: 'chat', params: { prompt: '你好' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.text).toBe('回复：你好');
  });
  it('POST /rpc command → commandBus 真实执行', async () => {
    const r = await rpc({ method: 'command', params: { command: '/status' } });
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
    const res = await fetch(`http://127.0.0.1:${PORT}/events`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
  });
});
