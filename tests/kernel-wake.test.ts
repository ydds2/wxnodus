// tests/kernel-wake.test.ts — A20 唤醒词匹配（纯函数）
import { describe, expect, it } from 'vitest'

import { matchWakeWord, WAKE_WORDS } from '../src/kernel/wake.js'

describe('matchWakeWord — 唤醒词匹配', () => {
  it('精确命中 wxnodus', () => {
    expect(matchWakeWord('wxnodus')).toBe('wxnodus')
  })

  it('大小写不敏感', () => {
    expect(matchWakeWord('WxNodus')).toBe('wxnodus')
    expect(matchWakeWord('WXNODUS')).toBe('wxnodus')
  })

  it('前后缀容忍（hey wxnodus / wxnodus 帮我）', () => {
    expect(matchWakeWord('hey wxnodus')).toBe('wxnodus')
    expect(matchWakeWord('wxnodus 帮我查一下')).toBe('wxnodus')
  })

  it('中文唤醒词', () => {
    expect(matchWakeWord('唤醒')).toBe('唤醒')
    expect(matchWakeWord('请唤醒 wxnodus')).toBe('wxnodus')
  })

  it('中文标点/空白容错', () => {
    expect(matchWakeWord('嘿，wxnodus！')).toBe('wxnodus')
    expect(matchWakeWord('wake 你好')).toBe('wake')
  })

  it('无关文本不命中', () => {
    expect(matchWakeWord('今天天气不错')).toBeNull()
    expect(matchWakeWord('你好')).toBeNull()
    expect(matchWakeWord('')).toBeNull()
    // 英文词边界：wakeboard/waking 不误唤醒
    expect(matchWakeWord('wakeboard')).toBeNull()
    expect(matchWakeWord('waking up')).toBeNull()
  })

  it('A22：自定义唤醒词表（settings.voice.wakeWords 接线）', () => {
    const custom = ['小助手', 'hey jane']

    expect(matchWakeWord('小助手 帮我查天气', custom)).toBe('小助手')
    expect(matchWakeWord('Hey Jane 现在几点', custom)).toBe('hey jane')
    // 自定义表不命中默认词（替换语义）
    expect(matchWakeWord('wxnodus', custom)).toBeNull()
    // 空表 → 永不唤醒
    expect(matchWakeWord('wxnodus', [])).toBeNull()
  })
})
