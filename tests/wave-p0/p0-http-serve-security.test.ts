// tests/wave-p0/p0-http-serve-security.test.ts — P0-01：serve HTTP 面安全
// 除 /health/live 外全部 Bearer 认证；health 不泄漏 dataDir/cwd/model/统计；OPTIONS 预检严格验证；
// 跨源状态修改稳定拒绝；body 超限结构化 413；SSE 同样认证。
import { describe, expect, it, vi } from 'vitest';
import { evaluateCsrf } from '../../src/presentation/http/csrfPolicy.js';
import { startServeServer, type ServeKernel } from '../../src/cli/serve.js';

const ALLOWLIST = ['https://app.example.test'];

function facts(overrides: Record<string, string | undefined> = {}) {
  return { method: 'POST', headers: overrides, originAllowlist: ALLOWLIST };
}

function preflight(overrides: Record<string, string | undefined> = {}) {
  return { method: 'OPTIONS', headers: overrides, originAllowlist: ALLOWLIST };
}

describe('csrf policy', () => {
  it('accepts a well-formed browser preflight from an allowed origin', () => {
    expect(evaluateCsrf(preflight({
      origin: 'https://app.example.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'Content-Type, Authorization',
    }))).toEqual({ ok: true });
  });

  it.each([
    { name: 'disallowed origin', headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' }, code: 'HTTP_CORS_PREFLIGHT_DENIED' },
    { name: 'disallowed method', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'DELETE' }, code: 'HTTP_CORS_PREFLIGHT_DENIED' },
    { name: 'disallowed header', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Evil' }, code: 'HTTP_CORS_PREFLIGHT_DENIED' },
  ] as const)('denies a preflight with $name', ({ headers, code }) => {
    expect(evaluateCsrf(preflight(headers))).toEqual({ ok: false, code });
  });

  it('passes a non-browser OPTIONS without preflight intent to the auth layer', () => {
    expect(evaluateCsrf(preflight())).toEqual({ ok: true });
  });

  it('blocks a state-changing request with a cross-origin Origin', () => {
    expect(evaluateCsrf(facts({ origin: 'https://evil.test' }))).toEqual({ ok: false, code: 'HTTP_CSRF_BLOCKED' });
  });

  it('blocks a browser cross-site request without Origin via Sec-Fetch-Site', () => {
    expect(evaluateCsrf(facts({ 'sec-fetch-site': 'cross-site' }))).toEqual({ ok: false, code: 'HTTP_CSRF_BLOCKED' });
  });

  it('passes non-browser clients without Origin and without Sec-Fetch-Site to the auth layer', () => {
    expect(evaluateCsrf(facts({}))).toEqual({ ok: true });
  });
});

const kernel: ServeKernel = {
  dataDir: 'C:/tmp/wxn-serve-test',
  cwd: 'C:/tmp',
  db: { prepare: () => ({ get: () => ({ c: 42 }), all: () => [{ id: 's1', title: '测试会话', updated_at: 1 }], run: () => ({ changes: 1 }) }) },
  bus: { on: () => () => {} },
  mem: { recall: () => [], recallHybrid: async () => [] },
  agent: { run: async p => ({ ok: true, text: `回复：${p}`, turns: 1, interrupted: false }) },
  commandBus: { execute: async c => ({ ok: true, output: `命令执行：${c}` }) },
  config: { get: () => ({ model: 'deepseek-v4-flash' }) },
};

describe('serve http security', () => {
  const PORT = 4793;
  const TOKEN = 'serve-test-token';
  const srv = startServeServer(kernel, PORT, { token: TOKEN, originAllowlist: ALLOWLIST });

  it('serves a minimal unauthenticated /health/live without leaking internals', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health/live`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('wxnodus-serve');
    expect(body).not.toHaveProperty('dataDir');
    expect(body).not.toHaveProperty('cwd');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('messages');
  });

  it('requires Bearer auth on /health, /rpc, and /events', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/health`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${PORT}/events`)).status).toBe(401);
    const rpc = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'command', params: { command: '/status' } }),
    });
    expect(rpc.status).toBe(401);
    expect(await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ method: 'command', params: { command: '/status' } }),
    })).toHaveProperty('status', 401);
  });

  it('serves an authenticated rpc request', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ method: 'command', params: { command: '/status' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ ok: true, output: '命令执行：/status' });
  });

  it('accepts only an allowlisted browser preflight and never answers unconditionally', async () => {
    const denied = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' },
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWLIST[0]!, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type, Authorization' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWLIST[0]!);
    expect(allowed.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('blocks a cross-origin state-changing request even with a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.test' },
      body: JSON.stringify({ method: 'command', params: { command: '/status' } }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an oversized request body with a structured 413', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: 'x'.repeat(1_100_000),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'HTTP_REQUEST_BODY_TOO_LARGE' } });
  });

  it('closes cleanly', async () => {
    await srv.close();
    expect(true).toBe(true);
  });
});

void vi;
