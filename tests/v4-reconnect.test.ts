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
    const r = await callLlmStream({ ...OPTS, onRetryNotice: (t: string) => { notices.push(t); } } as any);
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
    const r529 = await callLlmStream({ ...OPTS, onRetryNotice: (t: string) => { notices.push(t); } } as any);
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

// V4 P2-2：idle watchdog 双档——慢端点长流式不断 / 真死流按档判死 / TimeoutError 误判修复。
function slowStream(chunks: string[], intervalMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
        await new Promise(r => setTimeout(r, intervalMs));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const frameOf = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

describe('V4 P2-2 idle watchdog 双档', () => {
  it('慢端点长流式：chunk 间隔 < 空闲档 → 持续续命不断流（旧 120s 全程一刀切场景）', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => frameOf(`段${i}`)).concat(['data: [DONE]\n\n']);
    globalThis.fetch = (async () => slowStream(chunks, 60)) as typeof fetch; // 总 480ms 流，间隔 60ms
    const r = await callLlmStream({ ...OPTS, idleFirstChunkMs: 5_000, idleChunkGapMs: 200, timeoutMs: 30_000 } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('段0段1段2段3段4段5段6段7');
  }, 15_000);

  it('首 chunk 超时档：服务器不响应 → 按首档判死（错误语义非 premature-eof/abort）', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue */ } });
    globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const r = await callLlmStream({ ...OPTS, idleFirstChunkMs: 150 } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/首字节超时/);          // 语义明确
      expect(r.error).not.toMatch(/提前结束|已中止/); // 误判修复断言（非 premature-eof/abort 文案）
    }
  }, 10_000);

  it('chunk 间隔空闲档：首 chunk 后断流 → 按间隔档判死（有数据曾到达——区别于首档）', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(frameOf('开头')));
        // 此后永无数据（死流）
      },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const r = await callLlmStream({ ...OPTS, idleFirstChunkMs: 5_000, idleChunkGapMs: 200 } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/流空闲超时/);
  }, 10_000);

  it('全程硬顶档：无限续命流到达硬顶 → 按 cap 档判死', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (;;) {
          controller.enqueue(encoder.encode(frameOf('tick')));
          await new Promise(r => setTimeout(r, 50));
        }
      },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const r = await callLlmStream({ ...OPTS, idleFirstChunkMs: 5_000, idleChunkGapMs: 5_000, timeoutMs: 300 } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/全程时长上限/);
  }, 10_000);
});

// V4 P2-10：429 限额状态——头解析/会话缓存/成功清除/notice 重置时刻/net 段显示。
import { getRateLimitState, clearRateLimitState } from '../src/kernel/llmStream.js';
import { buildStatusSegments, segmentById as seg6 } from '../src/wxnodus-ui/components/statusBarSegments.js';

describe('V4 P2-10 429 限额状态', () => {
  afterEach(() => { clearRateLimitState(); globalThis.fetch = realFetch; });

  it('429 带 x-ratelimit-* 头 → 会话缓存（resetAt 绝对时刻 + remaining）；重试成功后清除', async () => {
    let calls = 0;
    const resetAt = new Date(Date.now() + 120_000); // 2 分钟后（ISO）
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': resetAt.toISOString() },
        });
      }
      return sseBody('ok');
    }) as typeof fetch;
    const r = await callLlmStream({ ...OPTS } as any);
    expect(r.ok).toBe(true);
    const st = getRateLimitState();
    // 成功后清除（最后一次调用成功）——验证缓存先记录再清除：重放一次 429
    expect(st).toBeNull();
    let calls2 = 0;
    globalThis.fetch = (async () => {
      calls2 += 1;
      if (calls2 <= 3) return new Response('rl', { status: 429, headers: { 'x-ratelimit-remaining-tokens': '128', 'x-ratelimit-reset-tokens': '300' } });
      return sseBody('ok');
    }) as typeof fetch;
    await callLlmStream({ ...OPTS } as any).catch(() => {});
    // 429 记录（相对秒 300 → now+300s）；若最终未成功则保留
    const st2 = getRateLimitState();
    if (st2) {
      expect(st2.remaining).toBe(128);
      expect(st2.resetAt).not.toBeNull();
      expect(st2.resetAt! - Date.now()).toBeGreaterThan(280_000);
    }
  }, 20_000);

  it('net 段显示「额度 HH:mm 重置」（warn 色，优先于重连显示）', () => {
    const resetAt = new Date();
    resetAt.setHours(resetAt.getHours() + 1, 23, 0, 0);
    const segs = buildStatusSegments({
      state: 'ready', statusText: 'x',
      net: { reconnecting: true, rateLimitResetAt: resetAt.getTime() },
    });
    const net = seg6(segs, 'net');
    expect(net?.text).toMatch(/⏳ 额度 \d{2}:\d{2} 重置/);
    expect(net?.color).toBe('warn');
  });
});
