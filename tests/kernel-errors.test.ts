// tests/kernel-errors.test.ts — C-4 错误处理统一：exitCodeForError 结构化优先契约
// 结构化路径（WxError 数值码 / HTTP status / errno·undici code / cause 链）先于文本嗅探；
// 纯消息错误走文本兜底（与既有行为一致——回归锁定）。
import { describe, expect, it } from 'vitest'
import { WX_ERR, WxError, exitCodeForError, isRetryableError } from '../src/kernel/errors.js'

describe('exitCodeForError（结构化优先）', () => {
  it('WxError 数值码：限流/上游 5xx/网络 → 75；请求语义错 → 1', () => {
    expect(exitCodeForError(new WxError(WX_ERR.RATE_LIMITED, 'x'))).toBe(75)
    expect(exitCodeForError(new WxError(WX_ERR.PROVIDER_ERROR, 'x'))).toBe(75)
    expect(exitCodeForError(new WxError(WX_ERR.NETWORK, 'x'))).toBe(75)
    expect(exitCodeForError(new WxError(WX_ERR.NO_KEY, 'x'))).toBe(1)
    expect(exitCodeForError(new WxError(WX_ERR.INVALID_PARAMS, 'x'))).toBe(1)
  })

  it('HTTP status 字段：429/5xx → 75；4xx → 1（结构化判定不依赖消息文本）', () => {
    expect(exitCodeForError({ status: 429 } as never)).toBe(75)
    expect(exitCodeForError({ status: 503 } as never)).toBe(75)
    expect(exitCodeForError({ statusCode: 500 } as never)).toBe(75)
    // 消息文本不含任何关键词——纯结构化判定
    expect(exitCodeForError(Object.assign(new Error('bad request'), { status: 400 }))).toBe(1)
    expect(exitCodeForError(Object.assign(new Error('not found'), { status: 404 }))).toBe(1)
  })

  it('errno / undici code 字段：网络族 → 75', () => {
    expect(exitCodeForError(Object.assign(new Error('fail'), { code: 'ETIMEDOUT' }))).toBe(75)
    expect(exitCodeForError(Object.assign(new Error('fail'), { code: 'ECONNRESET' }))).toBe(75)
    expect(exitCodeForError(Object.assign(new Error('fail'), { code: 'UND_ERR_SOCKET' }))).toBe(75)
    // 非网络 errno 不因 code 字段误判（回落文本兜底 → 1）
    expect(exitCodeForError(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(1)
  })

  it('cause 链（≤2 层）：深层结构化信息仍可判定', () => {
    const root = Object.assign(new Error('socket'), { code: 'ECONNREFUSED' })
    expect(exitCodeForError(new Error('fetch failed', { cause: root }))).toBe(75)
    const root4xx = Object.assign(new Error('bad'), { status: 401 })
    expect(exitCodeForError(new Error('outer', { cause: root4xx }))).toBe(1)
  })

  it('cause 环引用防死循环', () => {
    const a: { cause?: unknown } = {}
    a.cause = a
    expect(exitCodeForError(a as never)).toBe(1)
  })

  it('纯消息错误：文本兜底语义与既有行为一致（回归锁定）', () => {
    expect(exitCodeForError(new Error('429 限流'))).toBe(75)
    expect(exitCodeForError(new Error('HTTP 503 服务暂不可用'))).toBe(75)
    expect(exitCodeForError(new Error('请求超时 timeout'))).toBe(75)
    expect(exitCodeForError(new Error('参数非法'))).toBe(1)
    expect(exitCodeForError('随便一个字符串')).toBe(1)
  })

  it('isRetryableError 与退出码共用判定', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { status: 502 }))).toBe(true)
    expect(isRetryableError(new WxError(WX_ERR.NO_KEY, 'x'))).toBe(false)
  })
})
