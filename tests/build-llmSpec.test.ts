// tests/build-llmSpec.test.ts — /build LLM 规格化（P0-1）：JSON 抽取、校验、失败降级
import { afterEach, describe, expect, it, vi } from 'vitest'

import { aiMakeSpec } from '../src/build/llmSpec.js'

const deps = { baseURL: 'https://api.example.com/v1', model: 'test-model', key: 'k' }

function mockFetch(content: string, ok = true, status = 200) {
  return vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok, status,
    json: async () => ({ choices: [{ message: { content } }] }),
  }))
}

describe('aiMakeSpec — LLM 开放域规格化', () => {
  it('正常生成合法 Spec', async () => {
    mockFetch('{"title":"计算器","summary":"四则运算计算器","scaffold":"generic","acceptance":["输入算式得结果","历史记录","清空重置"]}')
    const spec = await aiMakeSpec('做一个计算器', deps)
    expect(spec).toEqual({
      title: '计算器',
      summary: '四则运算计算器',
      scaffold: 'generic',
      acceptance: ['输入算式得结果', '历史记录', '清空重置'],
    })
  })

  it('剥离 markdown 代码围栏', async () => {
    mockFetch('```json\n{"title":"待办","summary":"任务管理","scaffold":"todo","acceptance":["新增任务","标记完成","删除任务"]}\n```')
    const spec = await aiMakeSpec('做个待办', deps)
    expect(spec?.scaffold).toBe('todo')
  })

  it('未知模具归入 generic（不直接透传）', async () => {
    mockFetch('{"title":"x","summary":"y","scaffold":"calculator","acceptance":["a","b","c"]}')
    const spec = await aiMakeSpec('x', deps)
    expect(spec?.scaffold).toBe('generic')
  })

  it('acceptance 截断为 3 条；主观词导致校验失败返回 null', async () => {
    mockFetch('{"title":"x","summary":"y","scaffold":"generic","acceptance":["界面美观","b","c","d"]}')
    expect(await aiMakeSpec('x', deps)).toBeNull()
  })

  it('HTTP 失败 / 非 JSON / 空内容返回 null', async () => {
    mockFetch('server error', false, 500)
    expect(await aiMakeSpec('x', deps)).toBeNull()
    mockFetch('这不是 JSON')
    expect(await aiMakeSpec('x', deps)).toBeNull()
    mockFetch('')
    expect(await aiMakeSpec('x', deps)).toBeNull()
  })

  it('网络异常返回 null（不抛出）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await aiMakeSpec('x', deps)).toBeNull()
  })

  afterEach(() => vi.unstubAllGlobals())
})
