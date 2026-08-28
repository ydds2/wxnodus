// src/wxnodus-ui/components/statusBarPrimitives.ts — V4 L0-7：状态栏纯函数群
// （从 statusBar.tsx 抽离——行为零漂移纯搬运；组件与交互留原文件。
//   行数预算 lint L4 ratchet 驱动的第一步拆解）
import unicodeSpinners from 'unicode-animations'
import { stringWidth } from '@wxnodus/ink'

const FACE_TICK_MS = 2500

import { VERBS } from '../content/verbs.js'
import { FACES } from '../content/faces.js'
export { VERBS }
import { fmtDuration } from '../domain/messages.js'
import { statusSegmentsFor, type StatusSegments } from '../lib/layoutProfile.js'
import { getTuiTerminalTier } from '../lib/terminalTier.js'
import { mix, type Theme } from '../theme.js'
import type { IndicatorStyle, Notice } from '../bridge/interfaces.js'

export const VERB_PAD_LEN = VERBS.reduce((max, v) => Math.max(max, v.length), 0) + 1 // + ellipsis
export const padVerb = (verb: string) => `${verb}…`.padEnd(VERB_PAD_LEN, ' ')

// Compact alternates for the `emoji` and `ascii` indicator styles.
// Each entry is a fixed-width (display-width) glyph.
const EMOJI_FRAMES = ['⚕ ', '🌀', '🤔', '✨', '🍵', '🔮']
const ASCII_FRAMES = ['|', '/', '-', '\\']

// Faster tick for spinner-style indicators — they read as motion only
// at frame rates closer to their authored interval.
const SPINNER_TICK_MS = 100

interface IndicatorRender {
  frame: string
  intervalMs: number
  // When false, FaceTicker hides the rotating verb and just shows the
  // glyph + duration.  Lets `unicode` stay minimal while the other
  // styles keep the verb-rotation flavour users associate with the
  // running… status.
  showVerb: boolean
}

// cmd/ascii 档：emoji 帧含 astral 字形、unicode 帧含盲文——均退回 ASCII 帧
// （即使用户显式 /indicator emoji|unicode，也不在 conhost 上发射不安全字形）。
export const tierGlyphSet = (): 'full' | 'bmp' | 'ascii' => getTuiTerminalTier()?.capabilities.glyphSet ?? 'full'

export const renderIndicator = (style: IndicatorStyle, tick: number): IndicatorRender => {
  if (style === 'kaomoji') {
    return { frame: FACES[tick % FACES.length] ?? '', intervalMs: FACE_TICK_MS, showVerb: true }
  }

  if (style === 'emoji') {
    if (tierGlyphSet() !== 'full') {
      return { frame: ASCII_FRAMES[tick % ASCII_FRAMES.length] ?? '|', intervalMs: SPINNER_TICK_MS, showVerb: true }
    }

    return {
      frame: EMOJI_FRAMES[tick % EMOJI_FRAMES.length] ?? '⚕ ',
      intervalMs: SPINNER_TICK_MS * 6,
      showVerb: true
    }
  }

  if (style === 'ascii') {
    return {
      frame: ASCII_FRAMES[tick % ASCII_FRAMES.length] ?? '|',
      intervalMs: SPINNER_TICK_MS,
      showVerb: true
    }
  }

  // 'unicode' — braille spinner (fixed 1-col).  Authored interval is
  // ~80ms; honour it but bound below at a safe minimum so React
  // re-renders stay reasonable.  This style is for users who want
  // the cleanest possible status, so no verb rotation either.
  // cmd/ascii 档盲文不可用 → 退回 ASCII 单列帧（仍无 verb 旋转）。
  if (tierGlyphSet() !== 'full') {
    return { frame: ASCII_FRAMES[tick % ASCII_FRAMES.length] ?? '|', intervalMs: SPINNER_TICK_MS, showVerb: false }
  }

  const spinner = unicodeSpinners.braille
  const frame = spinner.frames[tick % spinner.frames.length] ?? '⠋'

  return { frame, intervalMs: Math.max(SPINNER_TICK_MS, spinner.interval), showVerb: false }
}

// `FACES` / `EMOJI_FRAMES` are static, so measure their widest glyph once at
// module load instead of rescanning on every status render.
const KAOMOJI_FRAME_WIDTH = FACES.reduce((max, f) => Math.max(max, stringWidth(f)), 1)
const EMOJI_FRAME_WIDTH = EMOJI_FRAMES.reduce((max, f) => Math.max(max, stringWidth(f)), 1)

const indicatorFrameWidth = (style: IndicatorStyle): number => {
  if (style === 'kaomoji') {
    return KAOMOJI_FRAME_WIDTH
  }

  if (style === 'emoji') {
    return EMOJI_FRAME_WIDTH
  }

  // 'ascii' and 'unicode' are single-column glyphs.
  return 1
}

// Bounded width of the elapsed-time clock, derived from `fmtDuration` itself so
// the reservation/budget stays consistent with what actually renders (it emits
// a space between units, e.g. `59m 59s` / `99h 59m`). Durations beyond this
// (100h+) are left to clip rather than reserving unbounded width.
export const MAX_DURATION_WIDTH = Math.max(
  stringWidth(fmtDuration(59 * 60_000 + 59_000)), // "59m 59s"
  stringWidth(fmtDuration(99 * 3_600_000 + 59 * 60_000)) // "99h 59m"
)

// Display width to reserve for the busy indicator so its verb + elapsed-time
// tail can't shove the model off-screen on narrow terminals. Style-aware:
// `unicode` is a bare 1-col braille spinner with no verb, while kaomoji/emoji/
// ascii add a fixed-width verb; any style adds a bounded elapsed-time tail.
// Mirrors FaceTicker's `frame + verbSegment + durationSegment` layout.
export const busyIndicatorWidth = (style: IndicatorStyle, hasDuration: boolean): number => {
  const { showVerb } = renderIndicator(style, 0)
  const verb = showVerb ? 1 + VERB_PAD_LEN : 0
  // ` · ` plus the bounded clock (e.g. `59m 59s`).
  const duration = hasDuration ? stringWidth(' · ') + MAX_DURATION_WIDTH : 0

  return indicatorFrameWidth(style) + verb + duration
}
export function ctxBarColor(pct: number | undefined, t: Theme) {
  if (pct == null) {
    return t.color.muted
  }

  if (pct >= 95) {
    return t.color.statusCritical
  }

  if (pct > 80) {
    return t.color.statusBad
  }

  if (pct >= 50) {
    return t.color.statusWarn
  }

  return t.color.statusGood
}

export function statusSessionCountLabel(count: number) {
  return `${count} 会话`
}

// Colour a credits notice by its level. The notice TEXT already carries its
// own glyph (⚠ • ✕ ✓) from the Python policy — we only tint it here, never
// prepend another glyph. `success` maps to the theme's green status colour.
export function noticeColor(level: Notice['level'], t: Theme): string {
  if (level === 'error') {
    return t.color.error
  }

  if (level === 'warn') {
    return t.color.warn
  }

  if (level === 'success') {
    return t.color.statusGood
  }

  // 'info' / undefined — keep it readable but understated.
  return t.color.accent
}

export function ctxBar(pct: number | undefined, w = 10) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const filled = Math.round((p / 100) * w)

  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

// 渐变上下文条（赛博深空）：已填充格沿「青 → 黄 → 红」热力色带按位置插值，
// 未填充格用 muted 暗点——占用即热、趋满即警，一眼读出水位
// S3 优化：热力格预计算缓存（StatusRule 随 FaceTicker 100ms tick 重渲染——按
// w+pct+主题色四元组缓存；有界（w 固定小值 × pct 0..100 × 主题数），无泄漏风险）
const ctxGradientCache = new Map<string, Array<{ ch: string; color: string }>>()

export function ctxGradientCells(pct: number | undefined, t: Theme, w = 10): Array<{ ch: string; color: string }> {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const key = `${w}:${p}:${t.color.statusGood}:${t.color.statusWarn}:${t.color.statusCritical}:${t.color.muted}`
  const hit = ctxGradientCache.get(key)
  if (hit) return hit
  const filled = Math.round((p / 100) * w)
  const cells: Array<{ ch: string; color: string }> = []
  for (let i = 0; i < w; i++) {
    if (i >= filled) {
      cells.push({ ch: '░', color: t.color.muted })
      continue
    }
    // 热力带分段插值：青(0) → 黄(0.5) → 红(1)
    const frac = w === 1 ? 0 : i / (w - 1)
    const color =
      frac < 0.5
        ? mix(t.color.statusGood, t.color.statusWarn, frac * 2)
        : mix(t.color.statusWarn, t.color.statusCritical, (frac - 0.5) * 2)
    cells.push({ ch: '█', color })
  }
  ctxGradientCache.set(key, cells)
  return cells
}

// `minLeftContent` is the display width of the high-priority left segments
// (status indicator + model + context). Reserving it makes the cwd/branch
// segment on the right yield FIRST on narrow terminals, instead of squeezing
// the loading indicator and model down to nothing.
export function statusRuleWidths(cols: number, cwdLabel: string, minLeftContent = 0) {
  const width = Math.max(1, Math.floor(cols || 1))
  const desiredSeparatorWidth = width >= 24 ? 3 : 1
  const baseMinLeft = width >= 24 ? 8 : 1
  // Never reserve more than the terminal width; never less than the historical
  // floor. With the default `minLeftContent = 0` this is identical to the old
  // behaviour, so callers that don't pass content are unaffected.
  const minLeftWidth = Math.min(width, Math.max(baseMinLeft, Math.floor(minLeftContent)))
  const maxRightWidth = Math.max(0, width - desiredSeparatorWidth - minLeftWidth)

  if (!cwdLabel || maxRightWidth <= 0) {
    return { leftWidth: width, rightWidth: 0, separatorWidth: 0 }
  }

  const rightWidth = Math.max(0, Math.min(stringWidth(cwdLabel), maxRightWidth))
  const separatorWidth = rightWidth > 0 ? desiredSeparatorWidth : 0
  const leftWidth = Math.max(1, width - separatorWidth - rightWidth)

  return { leftWidth, rightWidth, separatorWidth }
}

  // Progressive disclosure for the status rule's lower-priority tail segments.
  // As the terminal narrows we shed the least important pieces first (cost →
  // voice → compressions → duration → context bar). Background activity has
  // one canonical composer summary, so it is not repeated in the status rule.
  // Status and model are never gated here — they're guaranteed room by
  // `statusRuleWidths`.
export interface StatusBarSegments extends StatusSegments {}

export function statusBarSegments(cols: number): StatusBarSegments {
  return statusSegmentsFor(cols)
}
export const effortLabel = (effort?: string) => {
  const value = String(effort ?? '')
    .trim()
    .toLowerCase()

  return value && value !== 'medium' && value !== 'normal' && value !== 'default' ? value : ''
}

export const shortModelLabel = (model: string) =>
  model
    .split('/')
    .pop()!
    .replace(/^claude[-_]/, '')
    .replace(/^anthropic[-_]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b(\d+)\s+(\d+)\b/g, '$1.$2')
    .trim()

export const modelLabel = (model: string, effort?: string, fast?: boolean) =>
  [shortModelLabel(model), effortLabel(effort), fast ? 'fast' : ''].filter(Boolean).join(' ')
