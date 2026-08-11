// tests/kernel-vad.test.ts — A20 自研 VAD：RMS 能量检测 + 静音自动停止状态机
import { describe, expect, it } from 'vitest'

import { DEFAULT_VAD, VadTracker, vadConfigFromSettings, pcmToInt16, rmsOfBlock } from '../src/kernel/vad.js'

// 16kHz 单声道 s16le 合成音频工具
const silentBlock = (n = 1600) => new Int16Array(n) // 全零 = 静音
const toneBlock = (n = 1600, amp = 8000) => {
  const b = new Int16Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.round(Math.sin((i / n) * Math.PI * 8) * amp)
  return b
}

describe('rmsOfBlock — 块能量', () => {
  it('静音块 RMS 为 0', () => {
    expect(rmsOfBlock(silentBlock())).toBe(0)
  })

  it('语音块 RMS 大于静音阈值', () => {
    const rms = rmsOfBlock(toneBlock())
    expect(rms).toBeGreaterThan(DEFAULT_VAD.silenceThreshold)
  })

  it('空块返回 0', () => {
    expect(rmsOfBlock(new Int16Array(0))).toBe(0)
  })
})

describe('pcmToInt16 — Buffer 小端解析', () => {
  it('s16le 字节序正确', () => {
    const buf = Buffer.from([0x34, 0x12, 0x78, 0x56]) // 0x1234, 0x5678
    const out = pcmToInt16(buf)
    expect(out.length).toBe(2)
    expect(out[0]).toBe(0x1234)
    expect(out[1]).toBe(0x5678)
  })
})

describe('VadTracker — 静音自动停止', () => {
  it('纯静音不触发 speechEnded', () => {
    const vad = new VadTracker()
    for (let i = 0; i < 100; i++) {
      const r = vad.feed(silentBlock())
      expect(r.speechEnded).toBe(false)
      expect(r.state).toBe('silence')
    }
  })

  it('说话后静音达到阈值 → speechEnded（默认 1200ms = 12 块）', () => {
    const vad = new VadTracker()
    // 语音 500ms（5 块）
    for (let i = 0; i < 5; i++) {
      const r = vad.feed(toneBlock())
      expect(r.speechEnded).toBe(false)
      expect(r.state).toBe('speech')
    }
    // 静音 1100ms（11 块）——未到阈值
    for (let i = 0; i < 11; i++) {
      const r = vad.feed(silentBlock())
      expect(r.speechEnded).toBe(false)
    }
    // 第 12 块静音 → 结束
    const r = vad.feed(silentBlock())
    expect(r.speechEnded).toBe(true)
    expect(r.state).toBe('silence')
  })

  it('说话时长不足 minSpeechMs 时静音不结束（防误触发）', () => {
    const vad = new VadTracker()
    // 仅 1 块语音（100ms < 200ms 阈值）
    vad.feed(toneBlock())
    // 大量静音
    for (let i = 0; i < 30; i++) {
      const r = vad.feed(silentBlock())
      expect(r.speechEnded).toBe(false)
    }
  })

  it('说话后连续语音不结束（拖尾静音不累积）', () => {
    const vad = new VadTracker()
    // 语音 5 块
    for (let i = 0; i < 5; i++) vad.feed(toneBlock())
    // 静音 10 块
    for (let i = 0; i < 10; i++) vad.feed(silentBlock())
    // 继续语音——静音计数应重置
    const r = vad.feed(toneBlock())
    expect(r.speechEnded).toBe(false)
    expect(r.state).toBe('speech')
  })

  it('结束一次后可复用（新一轮录音从 silence 开始）', () => {
    const vad = new VadTracker()
    for (let i = 0; i < 5; i++) vad.feed(toneBlock())
    for (let i = 0; i < 12; i++) vad.feed(silentBlock())
    // 新一轮
    const r = vad.feed(toneBlock())
    expect(r.speechEnded).toBe(false)
    expect(r.state).toBe('speech')
  })
})

describe('vadConfigFromSettings — settings.voice.vad 接线（A22）', () => {
  it('未配置 voice.vad → undefined（用默认）', () => {
    expect(vadConfigFromSettings(undefined)).toBeUndefined()
    expect(vadConfigFromSettings({})).toBeUndefined()
    expect(vadConfigFromSettings({ voice: { recordKey: 'ctrl+b' } })).toBeUndefined()
  })

  it('部分配置 → 缺省值回退', () => {
    const cfg = vadConfigFromSettings({ voice: { vad: { silenceMs: 2000 } } })

    expect(cfg).toBeDefined()
    expect(cfg!.silenceMs).toBe(2000)
    expect(cfg!.silenceThreshold).toBe(DEFAULT_VAD.silenceThreshold)
    expect(cfg!.minSpeechMs).toBe(DEFAULT_VAD.minSpeechMs)
    expect(cfg!.blockSamples).toBe(DEFAULT_VAD.blockSamples)
  })

  it('非法值（0/负数/非数字）→ 回退默认', () => {
    const cfg = vadConfigFromSettings({ voice: { vad: { silenceMs: 0, silenceThreshold: '高', minSpeechMs: -5 } } })

    expect(cfg!.silenceMs).toBe(DEFAULT_VAD.silenceMs)
    expect(cfg!.silenceThreshold).toBe(DEFAULT_VAD.silenceThreshold)
    expect(cfg!.minSpeechMs).toBe(DEFAULT_VAD.minSpeechMs)
  })

  it('自定义配置生效于 VadTracker（短静音阈值 → 更快结束）', () => {
    // silenceMs=400ms（4 块）+ minSpeechMs=100ms（1 块）→ 说话 2 块后静音 4 块即结束
    const vad = new VadTracker({ ...DEFAULT_VAD, silenceMs: 400, minSpeechMs: 100 })
    vad.feed(toneBlock())
    vad.feed(toneBlock())
    let ended = false
    for (let i = 0; i < 4; i++) {
      ended = vad.feed(silentBlock()).speechEnded
    }
    expect(ended).toBe(true)
    // 默认 1200ms 阈值下同序列不结束（对比验证配置生效）
    const def = new VadTracker()
    def.feed(toneBlock())
    def.feed(toneBlock())
    let defEnded = false
    for (let i = 0; i < 4; i++) {
      defEnded = def.feed(silentBlock()).speechEnded
    }
    expect(defEnded).toBe(false)
  })
})
