// tests/kernel-llmStream.test.ts — LLM 流式调用服务（架构 P2）：SSE 解析/降级链/用量
import { afterEach, describe, expect, it, vi } from 'vitest'

import { callLlmStream, resetDegradedModel } from '../src/kernel/llmStream.js'

const deps = { baseURL: 'https://api.example.com/v1', model: 'm1', key: 'k' }
const MSG = { role: 'user' as const, content: 'hi' }

function sseChunks(...chunks: string[]): Array<{ done: boolean; value?: Uint8Array }> {
  const body = chunks.join('')
  return [{ done: false, value: new TextEncoder().encode(body) }, { done: true }]
}

function stubFetch(chunks: string[], ok = true, status = 200) {
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++
    return {
      ok, status,
      body: { getReader: () => {
        let i = 0
        const arr = sseChunks(...chunks)
        return { read: async () => arr[i++] ?? { done: true } }
      } },
    } as any
  }))
  return () => calls
}

describe('callLlmStream — SSE 解析', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetDegradedModel() })

  it('文本流：content 分片累积 + onToken 推送 + usage 提取', async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n',
      'data: [DONE]\n',
    ])
    const tokens: string[] = []
    const r = await callLlmStream({ ...deps, messages: [MSG], onToken: t => tokens.push(t) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toBe('你好')
    expect(tokens.join('')).toBe('你好')
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 2, cacheHitTokens: 0, cacheMissTokens: 0 })
  })

  it('usage 含前缀缓存字段（prompt_cache_hit/miss_tokens）→ 原样提取', async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":200}}\n',
      'data: [DONE]\n',
    ])
    const r = await callLlmStream({ ...deps, messages: [MSG] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.usage).toEqual({ promptTokens: 1000, completionTokens: 5, cacheHitTokens: 800, cacheMissTokens: 200 })
  })

  it('工具调用流：tool_calls 按 index 累积', async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_read","arguments":"{\\"path\\":\\"a"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ])
    const r = await callLlmStream({ ...deps, messages: [MSG] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.toolCalls.length).toBe(1)
    expect(r.toolCalls[0]!.name).toBe('fs_read')
    expect(r.toolCalls[0]!.arguments).toBe('{"path":"a"}')
  })

  it('思考字段别名（reasoning_content → thinking_content）回传原字段名', async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n',
      'data: {"choices":[{"delta":{"content":"回答"}}]}\n',
      'data: [DONE]\n',
    ])
    const r = await callLlmStream({ ...deps, messages: [MSG] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.reasoning).toBe('思考中')
    expect(r.reasoningField).toBe('reasoning_content')
  })

  it('SSE 错误对象/空响应/HTTP 失败 → 错误结果（不静默）', async () => {
    stubFetch(['data: {"error":{"message":"上下文超限"}}\n'])
    expect((await callLlmStream({ ...deps, messages: [MSG] })).ok).toBe(false)
    stubFetch(['data: [DONE]\n'])
    const r2 = await callLlmStream({ ...deps, messages: [MSG] })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toContain('空响应')
    stubFetch([''], false, 429)
    const r3 = await callLlmStream({ ...deps, messages: [MSG] })
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.status).toBe(429)
  })

  it('降级链：429 → 同 provider 备选重试（onDegrade 回调）', async () => {
    const degrade: Array<{ from: string; to: string }> = []
    // 新契约：429 先同模型退避重试一次——连续 429 后降级链才触发（瞬时限流不再误降级）
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 } as any)
      .mockResolvedValueOnce({ ok: false, status: 429 } as any)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        body: { getReader: () => {
          let i = 0
          const arr = sseChunks('data: {"choices":[{"delta":{"content":"降级成功"}}]}\n', 'data: [DONE]\n')
          return { read: async () => arr[i++] ?? { done: true } }
        } },
      } as any))
    const r = await callLlmStream({
      baseURL: deps.baseURL, model: 'deepseek-reasoner', key: 'k', messages: [MSG],
      onDegrade: (from, to) => degrade.push({ from, to }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toBe('降级成功')
    expect(r.model).not.toBe('deepseek-reasoner') // 降级后的备选模型
    expect(degrade.length).toBe(1)
  })
})

describe('429 同模型退避重试（一次）', () => {
  it('首次 429 → 退避后重试成功（同模型不降级）', async () => {
    const { callLlmStream } = await import('../src/kernel/llmStream.js');
    let calls = 0;
    const fakeFetch = async (): Promise<any> => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, headers: { get: () => '0' }, body: null };
      }
      // 第二次：真实 SSE 内容流（含 data chunk + [DONE]）
      const enc = new TextEncoder();
      const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\ndata: [DONE]\n\n')); c.close(); } });
      return { ok: true, status: 200, headers: { get: () => null }, body };
    };
    const orig = globalThis.fetch;
    (globalThis as any).fetch = fakeFetch;
    try {
      const r = await callLlmStream({ baseURL: 'https://mock', model: 'deepseek-chat', key: 'k', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5000 } as any);
      expect(r.ok).toBe(true);
      if (r.ok) expect((r as any).content).toContain('重试成功');
      expect(calls).toBe(2); // 一次 429 + 一次重试成功
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('连续 429 → 只重试一次后如实报限流（不无限重试）', async () => {
    const { callLlmStream } = await import('../src/kernel/llmStream.js');
    let calls = 0;
    const fakeFetch = async (): Promise<any> => {
      calls += 1;
      return { ok: false, status: 429, headers: { get: () => '0' }, body: null };
    };
    const orig = globalThis.fetch;
    (globalThis as any).fetch = fakeFetch;
    try {
      const r = await callLlmStream({ baseURL: 'https://mock', model: 'relay-custom-model', key: 'k', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5000 } as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(String(r.error)).toContain('429');
      expect(calls).toBe(2);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
});
