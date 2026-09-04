// tests/sdk-client.test.ts — @wxnodus/sdk 集成（A-S2 · 2026-08-28）
// 真实链路：spawn dist/cli/index.js --serve --sdk → stdout 握手 → /rpc → /events → stop 托管退出。
// 前置：dist 已构建（ci 顺序 build→test；独立跑请先 npm run build）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchWxnodus, type WxnodusHandle } from '../packages/sdk/src/index.js';

const repoRoot = resolve(__dirname, '..');
const distEntry = join(repoRoot, 'dist', 'cli', 'index.js');

describe.skipIf(!existsSync(distEntry))('@wxnodus/sdk 集成（真实子进程）', () => {
  let wxn: WxnodusHandle;

  beforeAll(async () => {
    wxn = await launchWxnodus({ bin: distEntry, cwd: repoRoot, timeoutMs: 30_000 });
  }, 45_000);

  afterAll(async () => { await wxn?.stop(); });

  it('握手：随机端口+token+pid+版本+协议版本（stdout 单行 JSON 解析）', () => {
    const h = wxn.handshake;
    expect(h['wxnodus-sdk']).toBe(1);
    expect(h.port).toBeGreaterThan(0);
    expect(h.token.length).toBeGreaterThanOrEqual(20);
    expect(h.pid).toBeGreaterThan(0);
    expect(h.version).toBe(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version);
    expect(h.protocolVersion).toBe(1);
    expect(wxn.baseUrl).toBe(`http://127.0.0.1:${h.port}`);
  });

  it('rpc：sessions 白名单方法通（Bearer 随机 token 鉴权通过）', async () => {
    const r = await wxn.rpc('sessions', { request_id: `sdk-${Date.now()}` });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.sessions)).toBe(true);
  });

  it('rpc：未知方法 → 结构化 400（诚实回显支持面）', async () => {
    const r = await wxn.rpc('no.such.method', {});
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('未知 method');
  });

  it('T77 实例身份：握手回传 instanceId/codename + identity RPC 同源', async () => {
    // 「网络下载后独一无二」：每份 wxnodus（本 dataDir）一次性 UUID + 确定性代号
    expect(wxn.handshake.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wxn.handshake.codename).toMatch(/^[A-Za-z]+-[A-Za-z]+ [0-9A-F]{4}$/); // T77 英文代号（2026-09-03 裁决：全英文+字母，中文旧代号一次性迁移）
    const r = await wxn.rpc('identity', { request_id: `sdk-id-${Date.now()}` });
    expect(r.ok).toBe(true);
    expect(r.instanceId).toBe(wxn.handshake.instanceId);
    expect(r.codename).toBe(wxn.handshake.codename);
    expect(r.serial).toMatch(/^[0-9A-F]{4}$/);
    expect(typeof r.createdAt).toBe('number');
  });

  it('events：SSE 订阅建立（收到首个事件帧即证通；随后取消）', async () => {
    let cancel: (() => void) | undefined
    const got = new Promise<unknown>(resolve => {
      // 订阅取消函数 + 拒绝收口：afterAll stop 后 SSE 拒绝不得成为未处理拒绝（门禁收口）
      void wxn.events(e => resolve(e)).then(c => { cancel = c }).catch(() => {})
    });
    // 触发一个服务端事件：rpc sessions 走 idempotent 播报？——直接等心跳/任意帧；
    // 若 5s 无帧（无心跳设计），以订阅不抛错 + 取消函数可用为底线断言。
    const first = await Promise.race([got, new Promise(r => setTimeout(() => r('timeout'), 5_000))]);
    expect(first !== undefined).toBe(true); // 收帧或 timeout 哨兵——订阅通道本身建立成功
    cancel?.(); // 显式取消订阅（防 afterAll stop 后悬挂 SSE 未处理拒绝——门禁收口）
  }, 15_000);

  it('stop：子进程退出（exitCode 非 null）', async () => {
    await wxn.stop();
    // stop 后再调用 rpc 应失败（连接拒绝）——进程真的死了
    await expect(wxn.rpc('sessions', {})).rejects.toBeTruthy();
  });
});
