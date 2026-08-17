// tests/kernel-secretDetect.test.ts — A20 语音密钥敏感检测（红线：不进历史/模型）
import { describe, expect, it } from 'vitest'

import { detectSecretInTranscript } from '../src/kernel/secretDetect.js'

describe('detectSecretInTranscript — 语音转写敏感检测', () => {
  it('/model set-key sk-xxx 命中 keyCommand 并提取密钥（/key 已并入 /model）', () => {
    const r = detectSecretInTranscript('/model set-key sk-abc123DEF456ghi789')
    expect(r?.kind).toBe('keyCommand')
    expect(r?.secret).toBe('sk-abc123DEF456ghi789')
    expect(r?.redacted).not.toContain('sk-abc123DEF456ghi789')
    expect(r?.redacted).toContain('••••')
  })

  it('/model set-key 单独出现（无密钥）→ keyCommand 引导', () => {
    const r = detectSecretInTranscript('/model set-key')
    expect(r?.kind).toBe('keyCommand')
    expect(r?.secret).toBe('')
  })

  it('旧转写 /key set sk-xxx 仍命中（兼容老习惯/历史转写）', () => {
    const r = detectSecretInTranscript('/key set sk-abc123DEF456ghi789')
    expect(r?.kind).toBe('keyCommand')
    expect(r?.secret).toBe('sk-abc123DEF456ghi789')
  })

  it('裸 /key <密钥> 变体同样命中', () => {
    const r = detectSecretInTranscript('/key sk-abc123DEF456ghi789')
    expect(r?.kind).toBe('keyCommand')
    expect(r?.secret).toBe('sk-abc123DEF456ghi789')
  })

  it('/key 单独出现（无密钥）→ keyCommand 引导', () => {
    const r = detectSecretInTranscript('/key')
    expect(r?.kind).toBe('keyCommand')
    expect(r?.secret).toBe('')
  })

  it('任意位置 sk- 密钥命中 apiKey', () => {
    const r = detectSecretInTranscript('我的密钥是 sk-abc123DEF456ghi789 请帮我设置')
    expect(r?.kind).toBe('apiKey')
    expect(r?.secret).toBe('sk-abc123DEF456ghi789')
    expect(r?.redacted).not.toContain('sk-abc123DEF456ghi789')
  })

  it('password/密码 赋值命中 password', () => {
    const r = detectSecretInTranscript('账号密码 password: hunter2secret')
    expect(r?.kind).toBe('password')
    expect(r?.secret).toBe('hunter2secret')
    const r2 = detectSecretInTranscript('密码：mima123456')
    expect(r2?.kind).toBe('password')
    expect(r2?.secret).toBe('mima123456')
  })

  it('中文"设置密钥"（无内容）→ keyCommand 引导', () => {
    const r = detectSecretInTranscript('帮我设置密钥')
    expect(r?.kind).toBe('keyCommand')
    expect(r?.secret).toBe('')
  })

  it('普通对话不命中（不进敏感通道）', () => {
    expect(detectSecretInTranscript('你好，帮我总结一下今天的任务')).toBeNull()
    expect(detectSecretInTranscript('搜索一下 sk 开头的东西是什么意思')).toBeNull()
    expect(detectSecretInTranscript('')).toBeNull()
  })

  it('短密钥（<8 位）不命中 sk- 模式', () => {
    expect(detectSecretInTranscript('用 sk-abc 试试')).toBeNull()
  })
})
