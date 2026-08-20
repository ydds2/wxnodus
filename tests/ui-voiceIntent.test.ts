// tests/ui-voiceIntent.test.ts — A20 语音意图：确认/取消词库（免提审批）
import { describe, expect, it } from 'vitest'

import { voiceConfirmChoice } from '../src/wxnodus-ui/lib/voiceIntent.js'

describe('voiceConfirmChoice — 语音确认意图', () => {
  it('确认词命中 approve', () => {
    for (const w of ['确认', '同意', '可以', '执行', '允许', '确定', '是', '好的', 'yes', 'ok', 'OK']) {
      expect(voiceConfirmChoice(w), w).toBe('approve')
    }
  })

  it('取消词命中 deny', () => {
    for (const w of ['取消', '拒绝', '不行', '不允许', '不要', '停止', 'no', 'NO']) {
      expect(voiceConfirmChoice(w), w).toBe('deny')
    }
  })

  it('长句子不判定（避免把完整对话误判为审批确认）', () => {
    expect(voiceConfirmChoice('我确认一下这个方案再执行吧')).toBeNull()
    expect(voiceConfirmChoice('好的我们开始吧今天天气不错')).toBeNull()
  })

  it('无关短词不判定', () => {
    expect(voiceConfirmChoice('嗯')).toBeNull()
    expect(voiceConfirmChoice('再来一次')).toBeNull()
    expect(voiceConfirmChoice('')).toBeNull()
  })
})
