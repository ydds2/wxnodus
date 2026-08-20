// tests/kernel-cache-engineering.test.ts — 波 1 ⑩ 前缀缓存工程
// 四件套：① 消息字段固定序（DeepSeek 字节稳定前缀）② cache_control 断点放置
// （crush agent.go:839-855 对标）③ 缓存费率归集（aider base_coder.py:2077-2096 对标）
// ④ 摘要独立单轮请求契约（gemini chatCompressionService.ts:361-379 / kimi compaction.py:126-131 对标）
import { describe, it, expect } from 'vitest';
import { buildChatRequest, applyCacheBreakpoints, MODEL_CATALOG } from '../src/kernel/providers.js';
import { estimateCostMicroUsd, costSummary } from '../src/kernel/cost.js';
import { costText, type CostQueryResult } from '../src/kernel/costQuery.js';
import { COMPRESSOR_SYSTEM_PROMPT, compactMessages } from '../src/kernel/memory.js';

const body = (req: ReturnType<typeof buildChatRequest>) => JSON.parse(req.body as string);

describe('前缀缓存工程：消息字段固定序', () => {
  it('相同内容不同构造顺序 → JSON 字节一致', () => {
    const a: any = {};
    a.content = 'x';
    a.role = 'user';
    const b = { role: 'user' as const, content: 'x' };
    const ra = body(buildChatRequest({ baseURL: 'u', model: 'm', key: 'k', messages: [a], stream: false })).messages[0];
    const rb = body(buildChatRequest({ baseURL: 'u', model: 'm', key: 'k', messages: [b], stream: false })).messages[0];
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
    expect(Object.keys(ra)).toEqual(['role', 'content']);
  });

  it('tool_calls/tool_call_id 键序固定（构造顺序漂移不影响字节）', () => {
    const m1: any = {
      tool_call_id: 'c1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
      content: null,
      role: 'assistant',
    };
    const m2: any = {
      role: 'assistant',
      content: null,
      tool_call_id: 'c1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
    };
    const r1 = body(buildChatRequest({ baseURL: 'u', model: 'm', key: 'k', messages: [m1], stream: false })).messages[0];
    const r2 = body(buildChatRequest({ baseURL: 'u', model: 'm', key: 'k', messages: [m2], stream: false })).messages[0];
    expect(Object.keys(r1)).toEqual(['role', 'content', 'tool_calls', 'tool_call_id']);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('未知扩展键（reasoning 续写等）按字典序兜底——稳定且不丢字段', () => {
    const m: any = { content: 'x', role: 'assistant', reasoning_content: 'r', zz: 1, aa: 2 };
    const r = body(buildChatRequest({ baseURL: 'u', model: 'm', key: 'k', messages: [m], stream: false })).messages[0];
    expect(Object.keys(r)).toEqual(['role', 'content', 'reasoning_content', 'aa', 'zz']);
  });
});

describe('cache_control 断点放置（crush agent.go:839-855 对标）', () => {
  it('system 首消息 + 末尾 2 条打 ephemeral，其余不带；原数组不被就地修改', () => {
    const msgs = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ] as any[];
    const out = applyCacheBreakpoints(msgs);
    expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(out[1].cache_control).toBeUndefined();
    expect(out[2].cache_control).toBeUndefined();
    expect(out[3].cache_control).toEqual({ type: 'ephemeral' });
    expect(out[4].cache_control).toEqual({ type: 'ephemeral' });
    expect(msgs[0].cache_control).toBeUndefined();
  });

  it('短数组边界：不足 tail 条全标注，空数组安全', () => {
    expect(applyCacheBreakpoints([])).toEqual([]);
    const one = applyCacheBreakpoints([{ role: 'user', content: 'u' }] as any[]);
    expect(one[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('buildChatRequest 默认关（OpenAI 兼容端点不携带 cache_control），显式开启才带断点', () => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] as any[];
    const off = body(buildChatRequest({ baseURL: 'u', model: 'deepseek-v4-pro', key: 'k', messages: msgs, stream: false }));
    expect(off.messages[0].cache_control).toBeUndefined();
    // 目录全部条目未声明 cacheControl 能力（诚实口径：当前无 Anthropic 式端点——DeepSeek 系走字节稳定自动缓存）
    for (const m of MODEL_CATALOG) expect(m.capabilities?.cacheControl ?? false).toBe(false);
    const on = body(buildChatRequest({ baseURL: 'u', model: 'deepseek-v4-pro', key: 'k', messages: msgs, stream: false, cacheControl: true }));
    expect(on.messages[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(on.messages[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('缓存费率归集（aider base_coder.py:2077-2096 对标）', () => {
  it('未收录缓存写价 → 输入价 ×1.25；官方公布价优先', () => {
    // kimi 无 cacheWrite 价：1M cacheMiss → 0.6×1.25=0.75 USD = 750000 µUSD
    expect(estimateCostMicroUsd('kimi-k2.7', { input: 0, output: 0, cacheMiss: 1_000_000 })).toBe(750_000);
    // deepseek 官方 cacheWrite=输入价 0.28 → 280000 µUSD
    expect(estimateCostMicroUsd('deepseek-chat', { input: 0, output: 0, cacheMiss: 1_000_000 })).toBe(280_000);
  });

  it('缓存净节省：官方读价才有正节省；写价上浮照实抵扣（绝不虚报）', () => {
    // deepseek：2M 命中省 (0.28-0.07)×2 = 0.42 USD；官方写价=输入价无上浮
    const s1 = costSummary([{ model: 'deepseek-chat', input: 0, output: 0, cacheHit: 2_000_000, cacheMiss: 0 }]);
    expect(s1.cacheSavingsUsd).toBeCloseTo(0.42, 6);
    const s2 = costSummary([{ model: 'deepseek-chat', input: 0, output: 0, cacheHit: 2_000_000, cacheMiss: 1_000_000 }]);
    expect(s2.cacheSavingsUsd).toBeCloseTo(0.42, 6);
    // kimi 无官方读价 → 命中省 0；1M 未命中上浮 0.15 → 净节省 -0.15
    const s3 = costSummary([{ model: 'kimi-k2.7', input: 0, output: 0, cacheHit: 1_000_000, cacheMiss: 1_000_000 }]);
    expect(s3.cacheSavingsUsd).toBeCloseTo(-0.15, 6);
  });
});

describe('「缓存省了多少」展示', () => {
  const q = (cacheSavingsUsd: number): CostQueryResult => ({
    usd: 1.5, unknown: 0, tokens: { input: 0, output: 0, total: 0 },
    dims: { cacheHit: 0, cacheMiss: 0, reasoning: 0 }, cacheSavingsUsd, models: 1, rows: [],
  });
  it('正节省才带后缀；无节省/无缓存不带', () => {
    expect(costText(q(0))).toBe('$1.5000');
    expect(costText(q(0.0312))).toBe('$1.5000（缓存节省 $0.0312）');
    expect(costText(q(-0.02))).toBe('$1.5000');
    expect(costText(null)).toBe('');
  });
});

describe('摘要独立请求契约（gemini chatCompressionService.ts:361-379 对标）', () => {
  it('COMPRESSOR_SYSTEM_PROMPT 契约：压缩器/字数上限/只输出快照（波 1 ⑤ 结构化后口径）', () => {
    expect(COMPRESSOR_SYSTEM_PROMPT).toContain('压缩器');
    expect(COMPRESSOR_SYSTEM_PROMPT).toContain('≤1200 字');
    expect(COMPRESSOR_SYSTEM_PROMPT).toContain('只输出 <state_snapshot>');
  });

  it('compactMessages：summarize 只收到中部文本（不含头尾），结果以 system 摘要写回，主数组不增不减', async () => {
    const msgs = [
      { role: 'system' as const, content: 'HEAD-0' },
      { role: 'user' as const, content: 'HEAD-1' },
      { role: 'user' as const, content: 'MID-A' },
      { role: 'assistant' as const, content: 'MID-B' },
      { role: 'user' as const, content: 'MID-C' },
      { role: 'user' as const, content: 'TAIL-1' },
      { role: 'assistant' as const, content: 'TAIL-2' },
    ];
    let received = '';
    const out = await compactMessages(msgs, async (text) => { received = text; return '摘要结果X'; }, { head: 2, tail: 2 });
    expect(received).toContain('MID-A');
    expect(received).not.toContain('HEAD-0');
    expect(received).not.toContain('TAIL-1');
    // head(2) + 1 条 system 摘要 + tail(2) = 5；原数组未被就地修改
    expect(out.length).toBe(5);
    expect(out[2].role).toBe('system');
    expect(out[2].content).toContain('摘要结果X');
    expect(msgs.length).toBe(7);
  });
});
