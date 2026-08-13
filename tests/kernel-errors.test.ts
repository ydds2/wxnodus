// tests/kernel-errors.test.ts — P1-2 退出码协议 + P1-3 错误码体系
import { describe, it, expect } from 'vitest';
import { WX_ERR, WxError, exitCodeForError, isRetryableError } from '../src/kernel/errors.js';
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';
import { createEventBus } from '../src/kernel/events.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('退出码协议（0/1/75）', () => {
  it('可重试失败（429/5xx/网络/超时）→ 75', () => {
    expect(exitCodeForError(new Error('429 Too Many Requests'))).toBe(75);
    expect(exitCodeForError(new Error('请求限流（429）'))).toBe(75);
    expect(exitCodeForError(new Error('模型服务端错误（500）'))).toBe(75);
    expect(exitCodeForError(new Error('fetch failed: timeout'))).toBe(75);
    expect(exitCodeForError(new Error('网络错误 ECONNRESET'))).toBe(75);
  });
  it('不可重试失败（配置/认证/4xx）→ 1', () => {
    expect(exitCodeForError(new Error('密钥无效或未配置（401）'))).toBe(1);
    expect(exitCodeForError(new Error('接口或模型不存在（404）'))).toBe(1);
    expect(exitCodeForError(new Error('请求格式错误（400）'))).toBe(1);
  });
  it('isRetryableError 与 exitCode 一致', () => {
    expect(isRetryableError(new Error('timeout'))).toBe(true);
    expect(isRetryableError(new Error('401 未授权'))).toBe(false);
  });
});

describe('错误码体系（4xxx/5xxx）', () => {
  it('WxError 携带 code；枚举分段', () => {
    const e = new WxError(WX_ERR.BUSY, 'busy');
    expect(e.code).toBe(4009);
    expect(WX_ERR.BUSY).toBe(4009);
    expect(WX_ERR.UNKNOWN_METHOD).toBeLessThan(5000);
    expect(WX_ERR.INTERNAL).toBeGreaterThanOrEqual(5000);
  });
  it('gateway busy 抛错 → RPC 返回 {ok:false, code:4009}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-err-'));
    try {
      const db = openDB(dir);
      const mem = createMemory(db);
      let runStarted: Promise<void> | null = null;
      let release: () => void = () => {};
      runStarted = new Promise(r => { release = r; });
      const agent = {
        run: async () => { await runStarted; return { ok: true, text: '', turns: 1, interrupted: false }; },
        abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true,
      };
      const gw = new GatewayClient({
        dataDir: dir, cwd: process.cwd(), db, mem,
        config: { get: () => ({}), getKey: () => undefined },
        bus: createEventBus(dir), settings: {}, commandBus: createCommandBus(),
        agent, applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
      } as any);
      (gw as any).running = true; // 模拟运行中
      const r = await gw.request('prompt.submit', { text: 'x' }) as { ok: boolean; code: number };
      expect(r.ok).toBe(false);
      expect(r.code).toBe(4009);
      closeDB(db);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
