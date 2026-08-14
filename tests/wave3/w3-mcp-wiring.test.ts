// tests/wave3/w3-mcp-wiring.test.ts — W3 MCP facade：incoming server 生产接线（stdio/Streamable HTTP）
// 密钥缺失 fail-closed（503 结构化 / startStdio reject）——绝不带病启动；密钥就位可构造、close 幂等；
// HTTP handler 对空 body 请求仍结构化响应（SDK 层错误，不抛假成功）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wave1CapabilityRegistry } from '../../src/application/capabilities/capabilityRegistry.js';
import { createMcpIncomingServer, hasRequestStateKey } from '../../src/application/mcp/mcpServerWiring.js';

const contextFactory = () => ({
  actorId: 'actor:test', sessionId: 's1', runId: null, correlationId: 'c1',
  policySnapshotId: 'p1', locale: 'en', source: 'cli' as const, capabilities: ['memory'],
  timestamp: '2026-08-13T00:00:00.000Z',
});
const capabilities = new Wave1CapabilityRegistry('policy-test', () => '2026-08-13T00:00:00.000Z');

const savedKey = process.env.WXNODUS_MCP_REQUEST_STATE_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.WXNODUS_MCP_REQUEST_STATE_KEY;
  else process.env.WXNODUS_MCP_REQUEST_STATE_KEY = savedKey;
});

describe('W3 MCP incoming server wiring', () => {
  it('fails closed without a requestState key: 503 structured + startStdio reject', async () => {
    delete process.env.WXNODUS_MCP_REQUEST_STATE_KEY;
    expect(hasRequestStateKey()).toBe(false);
    const mcp = createMcpIncomingServer({ capabilities, contextFactory });
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await mcp.httpHandler({}, res);
    expect(res.writeHead).toHaveBeenCalledWith(503, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(JSON.parse(String(res.end.mock.calls[0]?.[0]))).toEqual({
      ok: false, error: { code: 'MCP_REQUEST_STATE_KEY_MISSING' },
    });
    await expect(mcp.startStdio()).rejects.toMatchObject({ code: 'MCP_REQUEST_STATE_KEY_MISSING' });
    await expect(mcp.close()).resolves.toBeUndefined(); // 未连接时 close 幂等
  });

  it('constructs with a valid key and closes idempotently', async () => {
    process.env.WXNODUS_MCP_REQUEST_STATE_KEY = Buffer.alloc(32, 1).toString('base64');
    expect(hasRequestStateKey()).toBe(true);
    const mcp = createMcpIncomingServer({ capabilities, contextFactory });
    await expect(mcp.close()).resolves.toBeUndefined();
    await expect(mcp.close()).resolves.toBeUndefined();
  });

  it('serves a structured SDK response over HTTP (no fake success on empty body)', async () => {
    process.env.WXNODUS_MCP_REQUEST_STATE_KEY = Buffer.alloc(32, 1).toString('base64');
    const mcp = createMcpIncomingServer({ capabilities, contextFactory });
    const req = {
      method: 'POST', url: 'http://127.0.0.1/mcp',
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () { /* empty body */ },
    };
    const res = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() };
    await Promise.race([
      mcp.httpHandler(req, res),
      new Promise(resolve => { setTimeout(() => resolve('timeout'), 5000); }),
    ]);
    expect(res.writeHead.mock.calls.length + res.end.mock.calls.length).toBeGreaterThan(0);
    // 永不假成功：SDK 对空 body 的解析错误必须以 error 形状（JSON-RPC error）回包
    const written = [res.write.mock.calls, res.end.mock.calls].flat().map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('"result"');
  });
});
