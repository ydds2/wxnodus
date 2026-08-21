import { afterEach, describe, expect, it, vi } from 'vitest'

import { callLlmStream, resetDegradedModel, type LlmStreamResult } from '../src/kernel/llmStream.js'

const deps = { baseURL: 'https://api.example.com/v1', model: 'relay-custom-model', key: 'k' }
const MSG = { role: 'user' as const, content: 'hi' }
const encoder = new TextEncoder()

function streamResponse(chunks: string[], status = 200): Response {
  let index = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: encoder.encode(chunks[index++]) }
          : { done: true, value: undefined },
      }),
    },
  } as unknown as Response
}

function httpResponse(status: number, retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }),
    body: null,
  } as Response
}

function successfulResponse(content = 'ok'): Response {
  return streamResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    'data: [DONE]\n\n',
  ])
}

async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return promise
}

function expectFailure(result: LlmStreamResult, text: string, status?: number): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error).toContain(text)
  if (status !== undefined) expect(result.status).toBe(status)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetDegradedModel()
})

describe('callLlmStream strict SSE parsing', () => {
  it('accumulates text, reasoning, tool fragments, and usage across chunk boundaries', async () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"你","reasoning_content":"想","tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_","arguments":"{\\"p\\":"}}]}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"好","tool_calls":[{"index":0,"function":{"name":"read","arguments":"\\"a\\"}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":8,"prompt_cache_miss_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([payload.slice(0, 73), payload.slice(73)])))
    const tokens: string[] = []
    const reasoning: string[] = []

    const result = await callLlmStream({
      ...deps,
      messages: [MSG],
      onToken: token => tokens.push(token),
      onReasoning: token => reasoning.push(token),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe('你好')
    expect(tokens).toEqual(['你', '好'])
    expect(result.reasoning).toBe('想')
    expect(reasoning).toEqual(['想'])
    expect(result.reasoningField).toBe('reasoning_content')
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'fs_read', arguments: '{"p":"a"}' }])
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cacheHitTokens: 8,
      cacheMissTokens: 2,
      reasoningTokens: 1,
    })
  })

  it.each([
    ['malformed data JSON', ['data: {nope}\n\n'], 'SSE'],
    ['null response body', null, '响应体'],
    ['unterminated residual frame', ['data: {"choices":[]}'], 'SSE'],
    ['valid frames without [DONE]', ['data: {"choices":[{"delta":{}}]}\n\n'], '[DONE]'],
  ])('rejects %s', async (_name, chunks, message) => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('fetch', vi.fn(async () => chunks === null
      ? ({ ok: true, status: 200, headers: new Headers(), body: null } as Response)
      : streamResponse(chunks)))

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expectFailure(result, message)
  })

  it.each([
    ['huge', 1_000_000_000],
    ['fractional', 1.5],
    ['negative', -1],
    ['over-limit', 64],
  ])('rejects a %s tool-call index as malformed SSE', async (_name, index) => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn(async () => streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { name: 'read' } }] } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expectFailure(result, 'SSE')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('validates every tool-call index before emitting another semantic delta from the frame', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const onToken = vi.fn()
    const fetchMock = vi.fn(async () => streamResponse([
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: 'must-not-emit',
            tool_calls: [
              { index: 0, function: { name: 'read' } },
              { index: 64, function: { name: 'write' } },
            ],
          },
        }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG], onToken }))

    expectFailure(result, 'SSE')
    expect(onToken).not.toHaveBeenCalled()
  })

  it('rejects a tool-call fragment batch above the explicit count limit', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fragments = Array.from({ length: 65 }, () => ({ index: 0, function: { arguments: 'x' } }))
    const fetchMock = vi.fn(async () => streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: fragments } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expectFailure(result, 'SSE')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns a classified failure when the response body reader cannot be opened', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => { throw new TypeError('reader unavailable') } },
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expectFailure(result, '流读取失败')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty completed response without silently succeeding', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['data: [DONE]\n\n'])))

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expectFailure(result, '空响应')
  })
})

describe('callLlmStream failure policy', () => {
  it.each([401, 403, 404, 413])('classifies HTTP %s as terminal and does not retry', async status => {
    const fetchMock = vi.fn(async () => httpResponse(status))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callLlmStream({ ...deps, messages: [MSG] })

    expectFailure(result, String(status), status)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([429, 500, 503])('retries HTTP %s within a strict per-call attempt budget', async status => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn(async () => httpResponse(status, '0'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expectFailure(result, String(status), status)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a connection failure and succeeds', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(successfulResponse('connected'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({ ...deps, messages: [MSG] }))

    expect(result).toMatchObject({ ok: true, content: 'connected' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry an aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn(async () => { throw new DOMException('aborted', 'AbortError') })
    vi.stubGlobal('fetch', fetchMock)

    const result = await callLlmStream({ ...deps, messages: [MSG], signal: controller.signal })

    expectFailure(result, '中止')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not replay after a text delta followed by premature EOF', async () => {
    const onToken = vi.fn()
    const fetchMock = vi.fn(async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callLlmStream({ ...deps, messages: [MSG], onToken })

    expectFailure(result, '[DONE]')
    expect(onToken).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['reasoning', '{"choices":[{"delta":{"reasoning_content":"partial"}}]}'],
    ['tool-call', '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}'],
  ])('does not replay after a %s fragment', async (_name, data) => {
    const fetchMock = vi.fn(async () => streamResponse([`data: ${data}\n\n`]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callLlmStream({ ...deps, messages: [MSG] })

    expectFailure(result, '[DONE]')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('callLlmStream backoff and isolation', () => {
  it('uses capped exponential backoff with jitter (V4 P2-1: symmetric ±25%)', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 对称 jitter 中值 ×1.0（旧乘性为 ×1.5——行为变更显式化）
    const fetchMock = vi.fn(async () => httpResponse(503))
    vi.stubGlobal('fetch', fetchMock)

    const pending = callLlmStream({ ...deps, model: 'deepseek-reasoner', messages: [MSG] })
    await vi.advanceTimersByTimeAsync(249)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expectFailure(result, '503', 503)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['delta seconds', '3', 3000],
    ['HTTP-date', 'Thu, 01 Jan 2026 00:00:04 GMT', 4000],
  ])('honors Retry-After %s', async (_name, retryAfter, delay) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(httpResponse(429, retryAfter))
      .mockResolvedValueOnce(successfulResponse())
    vi.stubGlobal('fetch', fetchMock)

    const pending = callLlmStream({ ...deps, messages: [MSG] })
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts while waiting without issuing the next attempt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => httpResponse(429, '10'))
    vi.stubGlobal('fetch', fetchMock)

    const pending = callLlmStream({ ...deps, messages: [MSG], signal: controller.signal })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    const result = await pending

    expectFailure(result, '中止')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports the actual model after a successful catalog fallback', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const degraded: Array<{ from: string; to: string; status: number }> = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(httpResponse(503))
      .mockResolvedValueOnce(httpResponse(503))
      .mockResolvedValueOnce(successfulResponse('fallback'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await settleWithTimers(callLlmStream({
      ...deps,
      model: 'deepseek-reasoner',
      messages: [MSG],
      onDegrade: (from, to, status) => degraded.push({ from, to, status }),
    }))

    expect(result).toMatchObject({ ok: true, content: 'fallback', model: 'deepseek-chat' })
    expect(degraded).toEqual([{ from: 'deepseek-reasoner', to: 'deepseek-chat', status: 503 }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('isolates retry state across concurrent calls', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const attempts = new Map<string, number>()
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string
      attempts.set(model, (attempts.get(model) ?? 0) + 1)
      return attempts.get(model) === 1 ? httpResponse(429, '0') : successfulResponse(model)
    })
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await settleWithTimers(Promise.all([
      callLlmStream({ ...deps, model: 'concurrent-a', messages: [MSG] }),
      callLlmStream({ ...deps, model: 'concurrent-b', messages: [MSG] }),
    ]))

    expect(first).toMatchObject({ ok: true, content: 'concurrent-a', model: 'concurrent-a' })
    expect(second).toMatchObject({ ok: true, content: 'concurrent-b', model: 'concurrent-b' })
    expect(attempts).toEqual(new Map([['concurrent-a', 2], ['concurrent-b', 2]]))
  })

  it('isolates concurrent fallback chains across providers', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const primaryModels = new Set(['deepseek-reasoner', 'kimi-k2.7'])
    const attempts = new Map<string, number>()
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string
      attempts.set(model, (attempts.get(model) ?? 0) + 1)
      return primaryModels.has(model) ? httpResponse(503) : successfulResponse(model)
    })
    vi.stubGlobal('fetch', fetchMock)

    const [deepseek, kimi] = await settleWithTimers(Promise.all([
      callLlmStream({ ...deps, model: 'deepseek-reasoner', messages: [MSG] }),
      callLlmStream({ ...deps, model: 'kimi-k2.7', messages: [MSG] }),
    ]))

    expect(deepseek).toMatchObject({ ok: true, model: 'deepseek-chat' })
    expect(kimi).toMatchObject({ ok: true, model: 'kimi-k2.7-highspeed' })
    expect(attempts.get('deepseek-reasoner')).toBe(2)
    expect(attempts.get('kimi-k2.7')).toBe(2)
  })
})
