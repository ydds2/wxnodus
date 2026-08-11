// src/kernel/vad.ts — 自研 VAD（语音活动检测）：PCM s16le 块级 RMS 能量分析
// 免提闭环核心：说话 → 静音持续达阈值 → speechEnded（自动停止录音）。
// 纯函数/类实现，无任何依赖，可直接单测（合成静音/语音 PCM 块）。

export interface VadConfig {
  /** 每块采样数（默认 1600 = 100ms @ 16kHz） */
  blockSamples: number
  /** 静音 RMS 阈值（0-32768；默认 500——低于视为静音） */
  silenceThreshold: number
  /** 静音持续多少 ms 判定说话结束（默认 1200） */
  silenceMs: number
  /** 说话最短 ms（防环境误触发；默认 200） */
  minSpeechMs: number
  /** 采样率（默认 16000） */
  sampleRate: number
}

export const DEFAULT_VAD: VadConfig = {
  blockSamples: 1600,
  silenceThreshold: 500,
  silenceMs: 1200,
  minSpeechMs: 200,
  sampleRate: 16000
}

export type VadState = 'silence' | 'speech' | 'trailing'

export interface VadResult {
  /** true = 说话已结束（静音达到阈值且说话时长达标），应停止录音 */
  speechEnded: boolean
  state: VadState
  /** 累计说话时长 ms */
  speechMs: number
  /** 当前块 RMS */
  rms: number
}

/** 块 RMS（均方根能量）；空块返回 0。 */
export function rmsOfBlock(block: Int16Array): number {
  if (block.length === 0) {
    return 0
  }

  let sum = 0

  for (let i = 0; i < block.length; i++) {
    const s = block[i]!
    sum += s * s
  }

  return Math.sqrt(sum / block.length)
}

/**
 * VAD 状态机：逐块喂 PCM，跟踪 静音→说话→拖尾静音 三态。
 * 说话开始后静音持续 ≥ silenceMs 且说话 ≥ minSpeechMs → speechEnded=true 并复位。
 * 单例可跨多段录音复用（构造后 feed 新一轮自动从 silence 开始）。
 */
export class VadTracker {
  private inSpeech = false
  private speechBlocks = 0
  private trailingBlocks = 0

  constructor(private cfg: VadConfig = DEFAULT_VAD) {}

  feed(block: Int16Array): VadResult {
    const rms = rmsOfBlock(block)
    const blockMs = (block.length / this.cfg.sampleRate) * 1000
    const isSilent = rms < this.cfg.silenceThreshold

    if (!this.inSpeech) {
      if (!isSilent && blockMs > 0) {
        this.inSpeech = true
        this.speechBlocks = 1
        this.trailingBlocks = 0

        return { speechEnded: false, state: 'speech', speechMs: blockMs, rms }
      }

      return { speechEnded: false, state: 'silence', speechMs: 0, rms }
    }

    if (isSilent) {
      this.trailingBlocks++
      const speechMs = this.speechBlocks * blockMs
      const trailingMs = this.trailingBlocks * blockMs
      const ended = trailingMs >= this.cfg.silenceMs && speechMs >= this.cfg.minSpeechMs

      if (ended) {
        this.inSpeech = false
        this.speechBlocks = 0
        this.trailingBlocks = 0
      }

      return { speechEnded: ended, state: ended ? 'silence' : 'trailing', speechMs, rms }
    }

    this.speechBlocks++
    this.trailingBlocks = 0

    return { speechEnded: false, state: 'speech', speechMs: this.speechBlocks * blockMs, rms }
  }

  /** 当前是否在说话/拖尾（供唤醒监听判断"有语音活动"）。 */
  get active(): boolean {
    return this.inSpeech
  }
}

/** Buffer（s16le）→ Int16Array（小端逐字节）。 */
export function pcmToInt16(buf: Buffer): Int16Array {
  const n = Math.floor(buf.length / 2)
  const out = new Int16Array(n)

  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2)
  }

  return out
}
