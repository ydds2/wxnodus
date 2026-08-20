// tests/kernel-exec-server.test.ts — S-04 完整版 exec-server（supremacy 补轮 2026-08-18）
// 真实本机集成：startExecServer（随机端口）→ HTTP 契约（鉴权/路由/体限）→
// runRemoteExecServer 客户端闭环（echo/非零码/401/网络不可达/沙盒标注）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExecServer, deriveExecToken, runRemoteExecServer, type ExecServerHandle } from '../src/kernel/execServer.js';

let dir: string;
let srv: ExecServerHandle;
const SECRET = 'exec-test-shared-secret';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-execsrv-'));
  srv = await startExecServer({ port: 0, secret: SECRET, dataDir: dir, defaultProfile: 'off' });
});
afterAll(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const token = deriveExecToken(SECRET);
const exec = (body: unknown, auth = token) =>
  fetch(`http://127.0.0.1:${srv.port}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });

describe('exec-server HTTP 契约', () => {
  it('GET /health/live：无认证存活探针（零泄漏）', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/health/live`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).service).toBe('wxnodus-exec-server');
  });
  it('POST /exec：无 token / 错 token → 401（HMAC 派生 + timingSafeEqual）', async () => {
    const noAuth = await fetch(`http://127.0.0.1:${srv.port}/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo x' }),
    });
    expect(noAuth.status).toBe(401);
    const bad = await exec({ command: 'echo x' }, 'wrong-token');
    expect(bad.status).toBe(401);
  });
  it('POST /exec：命令执行 + 退出码诚实（非零码 ok=false）', async () => {
    const ok = await exec({ command: 'Write-Output EXEC_OK' });
    expect(ok.status).toBe(200);
    const j1 = (await ok.json()) as any;
    expect(j1.ok).toBe(true);
    expect(j1.out).toContain('EXEC_OK');
    expect(j1.sandboxed).toBe(false);
    expect(j1.note).toContain('未沙盒'); // profile=off 诚实标注
    const bad = await exec({ command: 'exit 3' });
    const j2 = (await bad.json()) as any;
    expect(j2.ok).toBe(false);
    expect(j2.code).toBe(3);
  });
  it('body 超限 413；非法 JSON 400；未知路由 404', async () => {
    const big = await exec({ command: 'echo ' + 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    const badJson = await fetch(`http://127.0.0.1:${srv.port}/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: 'not-json{',
    });
    expect(badJson.status).toBe(400);
    const nf = await fetch(`http://127.0.0.1:${srv.port}/nope`, { headers: { Authorization: `Bearer ${token}` } });
    expect(nf.status).toBe(404);
  });
  it('profile 参数请求远端沙盒：不可用时 fail-closed 拒绝执行（绝不降级裸跑）', async () => {
    // 本机沙盒探测在测试临时 dataDir 下可能失败——契约是「不可用即拒绝」，不是「降级假装」
    const r = await exec({ command: 'Write-Output SBX', profile: 'L0', timeoutMs: 15_000 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    if (j.sandboxed) {
      expect(j.note).toContain('L0');
    } else {
      expect(j.ok).toBe(false);
      expect(j.error).toContain('沙盒不可用');
    }
  });
});

describe('runRemoteExecServer 客户端闭环', () => {
  it('echo 往返（transportError=null）', async () => {
    const r = await runRemoteExecServer({ host: '127.0.0.1', port: srv.port, token }, 'Write-Output RPC_OK');
    expect(r.ok).toBe(true);
    expect(r.out).toContain('RPC_OK');
    expect(r.transportError).toBeNull();
  });
  it('错误 token → 401 明确提示（口令不一致指引）', async () => {
    const r = await runRemoteExecServer({ host: '127.0.0.1', port: srv.port, token: 'bad' }, 'echo x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('令牌无效');
  });
  it('网络不可达 → 连接失败提示（host:port 指引）', async () => {
    const r = await runRemoteExecServer({ host: '127.0.0.1', port: 1, token }, 'echo x');
    expect(r.ok).toBe(false);
    expect(r.transportError).toBe('network');
    expect(r.error).toContain('连接失败');
  });
});
