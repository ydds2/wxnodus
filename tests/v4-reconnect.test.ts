// tests/v4-reconnect.test.ts — V4 P2-1：断网重连工程
// ① connect 类 → 等待网络模式（指数退避 60s 封顶、总预算默认 10min、不占 MAX_ATTEMPTS）
// ② 429 尊重 Retry-After；529 更长退避 + 可见信号；对称 jitter
// ③ Esc（abort signal）等待期随时中止；④ durable：用户消息先落盘（等网期间 DB 已有——崩溃可恢复）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { callLlmStream } from '../src/kernel/llmStream.js';
import { openDB, closeDB, pickResumeSession } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';

const realFetch = globalThis.fetch;
function sseBody(text: string): Response {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { globalThis.fetch = realFetch; });

const OPTS = {
  baseURL: 'https://mock.test/v1', model: 'gpt-4o-mini', key: 'k',
  messages: [{ role: 'user', content: 'hi' }],
  // 缩短退避便于测试（等待网络预算 3s、基础退避不受影响——connect 首退避 = 250ms）
  waitNetworkMs: 3_000,
} as const;

describe('V4 P2-1 断网重连', () => {
  it('connect 失败 → 等待网络模式重连成功（notice 信号序列 + 不占降级槽位）', async () => {
    let calls = 0;
    const notices: string[] = [];
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls <= 2) { throw new TypeError('fetch failed'); } // 前两次断网
      return sseBody('恢复后回答');
    }) as typeof fetch;
    const r = await callLlmStream({ ...OPTS, onRetryNotice: t => notices.push(t) } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('恢复后回答');
    expect(calls).toBe(3);
    expect(notices.length).toBeGreaterThanOrEqual(2); // 每次等待前发可见信号
    expect(notices[0]).toMatch(/网络中断，第 1 次重连/);
    expect(notices.some(n => /Esc 可中止/.test(n))).toBe(true);
  }, 15_000);

  it('等待网络预算耗尽 → 诚实失败（不再无限等）', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r = await callLlmStream({ ...OPTS, waitNetworkMs: 600 } as any); // 600ms 预算
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/连接失败/);
  }, 15_000);

  it('Esc 等待期中止：abort signal 在等待网络期间触发 → 立即中止不烧预算', async () => {
    const ac = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new TypeError('fetch failed'); }) as typeof fetch;
    const p = callLlmStream({ ...OPTS, signal: ac.signal, waitNetworkMs: 60_000 } as any);
    setTimeout(() => ac.abort(), 400); // 首次等待（~250ms 退避）中触发 Esc
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/中止/);
    expect(calls).toBeLessThanOrEqual(2); // 未继续烧调用
  }, 10_000);

  it('429 尊重 Retry-After；529 分类为平台过载（更长退避不误判 500）', async () => {
    // 429 + Retry-After: 0（立即重试）→ 第二次成功
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      return sseBody('ok');
    }) as typeof fetch;
    const r429 = await callLlmStream({ ...OPTS } as any);
    expect(r429.ok).toBe(true);
    // 529：两次后成功（529 在 knownKind 表——不落入通用 500 分支）
    let calls2 = 0;
    const notices: string[] = [];
    globalThis.fetch = (async () => {
      calls2 += 1;
      if (calls2 === 1) return new Response('overloaded', { status: 529 });
      return sseBody('ok529');
    }) as typeof fetch;
    const r529 = await callLlmStream({ ...OPTS, onRetryNotice: t => notices.push(t) } as any);
    expect(r529.ok).toBe(true);
    expect(notices.some(n => /服务端过载/.test(n))).toBe(true);
  }, 15_000);
});

describe('V4 P2-1 durable：等网期间用户消息已在库（崩溃可恢复）', () => {
  it('mem.append user 先于模型调用 → pickResumeSession 命中未完成回合', () => {
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
    const d = mkdtempSync(join(process.cwd(), '.tmp', 'wx-durable-'));
    const db = openDB(d);
    try {
      const mem = createMemory(db);
      // agent.run 在模型调用前已 mem.append('user')（agent.ts:1082——断网等待期间此行已执行）
      mem.append('s-durable', 'user', '网络断时的提问');
      // 崩溃模拟：无 assistant 回复 → pickResumeSession 应命中（重启自动恢复语义）
      expect(pickResumeSession(db)).toBe('s-durable');
    } finally {
      closeDB(db);
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
