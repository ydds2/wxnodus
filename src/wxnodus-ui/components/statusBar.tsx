// src/wxnodus-ui/components/statusBar.tsx — 状态栏核心（UI 重设计 P0-3 自 appChrome 拆出，行为零漂移）
// 内容：忙碌指示器族（renderIndicator/FaceTicker）+ 状态栏宽度预算（statusRuleWidths/statusBarSegments）
// + 上下文热力条 + 子代理 HUD + 状态段渲染（StatusRule）。纯搬运：逻辑与注释未改动。
import { Box, stringWidth, Text } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import unicodeSpinners from 'unicode-animations'

import { $delegationState } from '../runtime/delegationStatus.js'
import { STATUS_LABEL } from '../hooks/useSessionShell.js'
import type { BatteryInfo, IndicatorStyle, Notice } from '../bridge/interfaces.js'
import { useTurnSelector } from '../runtime/flowStore.js'
import { DEV_CREDITS_MODE } from '../config/env.js'
import { FACES } from '../content/faces.js'
import { VERBS } from '../content/verbs.js'
import { fmtDuration } from '../domain/messages.js'
import { statusSegmentsFor, type StatusSegments } from '../lib/layoutProfile.js'
import { getTuiTerminalTier } from '../lib/terminalTier.js'
import { buildSubagentTree, treeTotals, widthByDepth } from '../lib/subagentTree.js'
import { fmtK } from '../lib/text.js'
import { mix, type Theme } from '../theme.js'
import type { Usage } from '../types.js'
import { icon } from '../glyphs.js'

const FACE_TICK_MS = 2500

// Keep verb segment width stable so status-bar content to the right doesn't
// jitter when the ticker rotates between short/long verbs.
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
const tierGlyphSet = (): 'full' | 'bmp' | 'ascii' => getTuiTerminalTier()?.capabilities.glyphSet ?? 'full'

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

function FaceTicker({ color, startedAt, style }: { color: string; startedAt?: null | number; style: IndicatorStyle }) {
  const [tick, setTick] = useState(() => Math.floor(Math.random() * 1000))
  const [verbTick, setVerbTick] = useState(() => Math.floor(Math.random() * VERBS.length))
  const [now, setNow] = useState(() => Date.now())

  // Pre-compute cadence + verb-visibility for the active style so an
  // `/indicator` switch re-arms the interval (and skips the verb timer
  // for verb-less styles like `unicode`) without leaving the previous
  // timer dangling.
  const { intervalMs, showVerb } = renderIndicator(style, 0)

  useEffect(() => {
    const glyph = setInterval(() => setTick(n => n + 1), intervalMs)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    // Verb timer is gated on `showVerb` — `unicode` style hides the verb
    // entirely, so cycling `verbTick` would be an avoidable re-render.
    const verb = showVerb ? setInterval(() => setVerbTick(n => n + 1), FACE_TICK_MS) : null

    return () => {
      clearInterval(glyph)
      clearInterval(clock)

      if (verb !== null) {
        clearInterval(verb)
      }
    }
  }, [intervalMs, showVerb])

  const { frame } = renderIndicator(style, tick)
  const verb = VERBS[verbTick % VERBS.length] ?? ''
  const verbSegment = showVerb ? ` ${padVerb(verb)}` : ''
  // Leading space keeps a gap between the frame and the duration when the
  // verb segment is hidden (e.g. `unicode` spinner style).  When the verb
  // IS shown, its trailing padding already provides the gap, so the extra
  // space is harmless.
  const durationSegment = startedAt ? ` · ${fmtDuration(now - startedAt)}` : ''

  return (
    <Text color={color}>
      {frame}
      {verbSegment}
      {durationSegment}
    </Text>
  )
}

function ctxBarColor(pct: number | undefined, t: Theme) {
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

function statusSessionCountLabel(count: number) {
  return `${count} 会话`
}

// Colour a credits notice by its level. The notice TEXT already carries its
// own glyph (⚠ • ✕ ✓) from the Python policy — we only tint it here, never
// prepend another glyph. `success` maps to the theme's green status colour.
function noticeColor(level: Notice['level'], t: Theme): string {
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

function ctxBar(pct: number | undefined, w = 10) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const filled = Math.round((p / 100) * w)

  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

// 渐变上下文条（赛博深空）：已填充格沿「青 → 黄 → 红」热力色带按位置插值，
// 未填充格用 muted 暗点——占用即热、趋满即警，一眼读出水位
function ctxGradientCells(pct: number | undefined, t: Theme, w = 10): Array<{ ch: string; color: string }> {
  const p = Math.max(0, Math.min(100, pct ?? 0))
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

function SpawnHud({ t }: { t: Theme }) {
  // Tight HUD that only appears when the session is actually fanning out.
  // Colour escalates to warn/error as depth or concurrency approaches the cap.
  const delegation = useStore($delegationState)
  const subagents = useTurnSelector(state => state.subagents)

  const tree = useMemo(() => buildSubagentTree(subagents), [subagents])
  const totals = useMemo(() => treeTotals(tree), [tree])

  if (!totals.descendantCount && !delegation.paused) {
    return null
  }

  const maxDepth = delegation.maxSpawnDepth
  const maxConc = delegation.maxConcurrentChildren
  const depth = Math.max(0, totals.maxDepthFromHere)
  const active = totals.activeCount

  // `max_concurrent_children` is a per-parent cap, not a global one.
  // `activeCount` sums every running agent across the tree and would
  // over-warn for multi-orchestrator runs.  The widest level of the tree
  // is a closer proxy to "most concurrent spawns that could be hitting a
  // single parent's slot budget".
  const widestLevel = widthByDepth(tree).reduce((a, b) => Math.max(a, b), 0)
  const depthRatio = maxDepth ? depth / maxDepth : 0
  const concRatio = maxConc ? widestLevel / maxConc : 0
  const ratio = Math.max(depthRatio, concRatio)

  const color = delegation.paused || ratio >= 1 ? t.color.error : ratio >= 0.66 ? t.color.warn : t.color.muted

  const pieces: string[] = []

  if (delegation.paused) {
    pieces.push('⏸ paused')
  }

  if (totals.descendantCount > 0) {
    const depthLabel = maxDepth ? `${depth}/${maxDepth}` : `${depth}`
    pieces.push(`d${depthLabel}`)

    if (active > 0) {
      // Label pairs the widest-level count (drives concRatio above) with
      // the total active count for context.  `W/cap` triggers the warn,
      // `+N` is everything else currently running across the tree.
      const extra = Math.max(0, active - widestLevel)
      const widthLabel = maxConc ? `${widestLevel}/${maxConc}` : `${widestLevel}`
      const suffix = extra > 0 ? `+${extra}` : ''
      pieces.push(`${icon('battery')}${widthLabel}${suffix}`)
    }
  }

  const atCap = depthRatio >= 1 || concRatio >= 1

  return (
    <Text color={color}>
      {atCap ? ` │ ${icon('warn')} ` : ' │ '}
      {pieces.join(' ')}
    </Text>
  )
}

function SessionDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(id)
  }, [startedAt])

  return fmtDuration(now - startedAt)
}

function IdleSince({ endedAt }: { endedAt: number }) {
  // Time since the last final agent response. Re-ticks every second like
  // SessionDuration so the read-out stays live while the session idles.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(id)
  }, [endedAt])

  return `${icon('check')} ${fmtDuration(now - endedAt)}`
}

const effortLabel = (effort?: string) => {
  const value = String(effort ?? '')
    .trim()
    .toLowerCase()

  return value && value !== 'medium' && value !== 'normal' && value !== 'default' ? value : ''
}

const shortModelLabel = (model: string) =>
  model
    .split('/')
    .pop()!
    .replace(/^claude[-_]/, '')
    .replace(/^anthropic[-_]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b(\d+)\s+(\d+)\b/g, '$1.$2')
    .trim()

const modelLabel = (model: string, effort?: string, fast?: boolean) =>
  [shortModelLabel(model), effortLabel(effort), fast ? 'fast' : ''].filter(Boolean).join(' ')

export function GoodVibesHeart({ tick, t }: { tick: number; t: Theme }) {
  const [active, setActive] = useState(false)
  const [color, setColor] = useState(t.color.accent)

  useEffect(() => {
    if (tick <= 0) {
      return
    }

    const palette = [t.color.error, t.color.warn, t.color.accent]
    setColor(palette[Math.floor(Math.random() * palette.length)]!)
    setActive(true)

    const id = setTimeout(() => setActive(false), 650)

    return () => clearTimeout(id)
  }, [t.color.accent, tick])

  if (!active) {
    return null
  }

  return <Text color={color}>♥</Text>
}

export function StatusRule({
  cwdLabel,
  sessionTitle,
  battery,
  cols,
  busy,
  status,
  statusColor,
  model,
  modelFast,
  modelReasoningEffort,
  indicatorStyle = 'kaomoji',
  notice,
  selectionHint,
  usage,
  balanceLabel,
  balanceStale,
  balanceLow,
  usageLabel,
  lastTurnEndedAt,
  liveSessionCount,
  sessionStartedAt,
  showCost,
  turnStartedAt,
  voiceLabel,
  permLabel,
  permTone,
  pet,
  /** P2：配置面板固定入口（⚙ 尾段可点——面板右分栏直达，不靠记忆） */
  onConfigClick,
  onSessionCountClick,
  onBalanceClick,
  onUsageClick,
  onVoiceClick,
  onCwdClick,
  onModelClick,
  t
}: StatusRuleProps) {
  const pct = usage.context_percent
  const barColor = ctxBarColor(pct, t)
  const segs = statusBarSegments(cols)

  // On narrow terminals the context read-out collapses to a bare token count
  // (`12k tok`) and the visual fill bar is dropped entirely.
  const ctxLabel = usage.context_max
    ? segs.compactCtx
      ? `${fmtK(usage.context_used ?? 0)} tok`
      : `${fmtK(usage.context_used ?? 0)}/${fmtK(usage.context_max)}`
    : usage.total > 0
      ? `${fmtK(usage.total)} tok`
      : ''

  const bar = !segs.compactCtx && usage.context_max ? ctxBar(pct) : ''
  const modelText = modelLabel(model, modelReasoningEffort, modelFast)

  // A19：鼠标辅助提示占位（选中/悬停/复制反馈）——优先级高于 notice 与
  // status，busy 时也让 FaceTicker 让位（提示是即时操作反馈，3s 自动清）。
  // 宽度封顶，超长截断，不挤压 model │ ctx。
  const HINT_RESERVE_MAX = 32
  const showHint = !!selectionHint
  const hintReserve = showHint ? Math.min(stringWidth(selectionHint), HINT_RESERVE_MAX) : 0

  // A credits notice replaces the status/verb slot, but only when idle —
  // while busy the FaceTicker always wins (R1 render priority). The notice
  // text carries its own glyph; we only tint it (R1) and let it shrink (R3-M7).
  const showNotice = !busy && !!notice?.text
  // The notice slot is shrinkable (flexShrink={1}, truncate-end), so reserve
  // only a small bounded width for it in the essentials budget — enough that
  // a short notice never gets crushed, but a long one ellipsizes instead of
  // shoving `model │ ctx` off-screen (R3-M7). Cap at the notice's own width
  // so short notices reserve exactly what they need.
  const NOTICE_RESERVE_MAX = 24
  const noticeReserve = showNotice ? Math.min(stringWidth(notice!.text), NOTICE_RESERVE_MAX) : 0

  // Width of the must-keep left segments (indicator + model + context). They
  // are pinned (never shrink) and reserved so the cwd/branch on the right
  // yields first. The busy face width depends on the active /indicator style
  // (kaomoji is wide + verb; unicode is a bare 1-col spinner). When a notice
  // occupies the slot it reserves only `noticeReserve` (it shrinks/truncates).
  // A22：busy 时槽位 = FaceTicker + 动态 stage 文本（正在做什么——实时变化）
  const busyFaceWidth = busyIndicatorWidth(indicatorStyle, turnStartedAt != null)
  const slotWidth = showHint
    ? hintReserve
    : busy
      ? busyFaceWidth + stringWidth(status)
      : showNotice
        ? noticeReserve
        : stringWidth(status) + (permLabel ? stringWidth(`[${permLabel}] `) : 0)

  // 宠物 5 列 + 1 空格——计入必须保留预算，pinned 区不挤压
  const PET_RESERVE = pet ? 6 : 0

  const essentialWidth =
    PET_RESERVE +
    stringWidth('─ ') +
    slotWidth +
    stringWidth(' │ ') +
    stringWidth(modelText) +
    (ctxLabel ? stringWidth(' │ ') + stringWidth(ctxLabel) : 0)

  // 模式徽章语义着色（Kimi 同款：风险越高越醒目）
  const permColor =
    permTone === 'error'
      ? t.color.error
      : permTone === 'warn'
        ? t.color.warn
        : permTone === 'accent'
          ? t.color.accent
          : permTone === 'good'
            ? t.color.statusGood
            : t.color.muted

  const { leftWidth, rightWidth, separatorWidth } = statusRuleWidths(cols, cwdLabel, essentialWidth)

  // Whole-segment progressive disclosure for the tail: a segment renders only
  // if it fits in the space left after the pinned essentials, evaluated in
  // descending priority order — bar, duration, compressions, voice, session
  // count, cost. Lower-priority segments drop first and nothing truncates
  // mid-segment, so status/model/context are never crushed.
  const SEP = stringWidth(' │ ')
  let tailBudget = Math.max(0, leftWidth - essentialWidth)
  const fits = (w: number) => {
    if (tailBudget >= w) {
      tailBudget -= w

      return true
    }

    return false
  }

  const sessionCountText = liveSessionCount > 0 ? statusSessionCountLabel(liveSessionCount) : ''
  const compressions = typeof usage.compressions === 'number' ? usage.compressions : 0
  const costText = typeof usage.cost_usd === 'number' ? `$${usage.cost_usd.toFixed(4)}` : ''
  // Dev-only readout (WXNODUS_DEV_CREDITS). The server omits the key entirely unless the
  // flag is on, so this segment self-hides for normal users. micros→cents is allowed money
  // math (display formatting) — never parseFloat a *_usd. Signed: a mid-session top-up that
  // raises remaining nets a negative Δ (honest).
  const devCreditsText =
    typeof usage.dev_credits_spent_micros === 'number'
      ? `Δ ${(usage.dev_credits_spent_micros / 10000).toFixed(1)}¢`
      : ''

  const showBar = !!bar && fits(SEP + stringWidth(`[${bar}] ${pct != null ? `${pct}%` : ''}`))
  // 💰/📊：余额与 token 区间两个段独立出现。预算顺序紧跟 bar——尾段中最高
  // 优先级（钱最要紧），窄屏先砍 duration/cost 等低优先级段。
  const showBalanceSeg = segs.balance && !!balanceLabel && fits(SEP + stringWidth(balanceLabel))
  const showUsageSeg = segs.usage && !!usageLabel && fits(SEP + stringWidth(usageLabel))
  const showDuration = segs.duration && !!sessionStartedAt && fits(SEP + MAX_DURATION_WIDTH)
  // Idle clock — time since the last final agent response. Hidden while busy
  // (the FaceTicker's elapsed tail covers the live turn) and before the first
  // turn completes. Shares the duration breakpoint and width reservation.
  const showIdle = segs.duration && !busy && lastTurnEndedAt != null && fits(SEP + stringWidth(`${icon('check')} `) + MAX_DURATION_WIDTH)
  const showCompressions = segs.compressions && compressions > 0 && fits(SEP + stringWidth(`cmp ${compressions}`))
  const showVoice = segs.voice && !!voiceLabel && fits(SEP + stringWidth(voiceLabel))
  // A7：电池段（⚡ 充电中 / ◌ 放电中；分级着色 good/warn/bad/critical）——
  // 符号用 BMP 宽字符（emoji 🔋 在旧终端字体下显示 �）
  const batteryLabel = battery?.available
    ? battery.percent != null
      ? `${battery.plugged ? '⚡' : '◌'} ${battery.percent}%`
      : battery.plugged ? '⚡' : '◌'
    : ''
  const showBattery = battery?.available && fits(SEP + stringWidth(batteryLabel))
  const showSessionCount = !!sessionCountText && fits(SEP + stringWidth(sessionCountText))
  const showCostSeg = segs.cost && showCost && !!costText && fits(SEP + stringWidth(costText))
  // No segs flag / no showCost coupling — it's a server-gated dev readout, lowest priority,
  // so it consumes tail budget LAST and drops first on a narrow terminal.
  const showDevCredits = !!devCreditsText && fits(SEP + stringWidth(devCreditsText))
  // P2：⚙ 配置入口——最低优先级尾段（窄屏最先让位），点击直达右分栏配置面板
  const showConfigEntry = !!onConfigClick && fits(stringWidth(' ⚙'))

  const handleSessionCountClick = (event: { stopImmediatePropagation?: () => void }) => {
    event.stopImmediatePropagation?.()
    onSessionCountClick?.()
  }

  const sessionCountNode = onSessionCountClick ? (
    <Box flexShrink={0} onClick={handleSessionCountClick}>
      <Text color={t.color.accent}> │ {sessionCountText}</Text>
    </Box>
  ) : (
    <Text color={t.color.muted}> │ {sessionCountText}</Text>
  )

  return (
    // 赛博深空底条：整行 statusBg 背景（文字自动继承背景色）——状态栏从
    // 纯文本行升级为高亮带，与消息区形成层次
    <Box height={1} backgroundColor={t.color.statusBg}>
      <Box flexDirection="row" flexShrink={1} overflow="hidden" width={leftWidth}>
        {/* Leading pinned chrome: accent 锚点竖条 + busy face / idle status. When a
            notice occupies the slot the status text is dropped — the notice
            renders as a separate shrinkable box below so a long notice
            ellipsizes instead of crushing model │ ctx (R3-M7). */}
        <Box flexDirection="row" flexShrink={0}>
          {pet}
          <Text color={t.color.accent} bold>{'▍'}</Text>
          <Text color={t.color.border}>{'─ '}</Text>
          {/* A22：busy 时 FaceTicker + 动态 stage 文本并排——"正在做什么"实时可见（此前 busy 槽位只有动画，状态文本被遮蔽） */}
          {busy && !showHint ? (
            <Box flexDirection="row" flexShrink={1} overflow="hidden">
              <FaceTicker color={statusColor} startedAt={turnStartedAt} style={indicatorStyle} />
              <Text color={statusColor} wrap="truncate-end">
                {' '}
                {STATUS_LABEL[status] ?? status}
              </Text>
            </Box>
          ) : showHint || showNotice ? null : (
            <Text color={statusColor} bold={status === 'running…'} wrap="truncate-end">
              {permLabel ? (
                <Text color={permColor} bold>{`[${permLabel}]`}</Text>
              ) : null}
              {permLabel ? ' ' : null}
              {STATUS_LABEL[status] ?? status}
            </Text>
          )}
        </Box>
        {/* Notice slot — the only shrinkable left element (R3-M7). Sits in a
            flexShrink={1} box with truncate-end so it yields/ellipsizes
            before the pinned model │ ctx box ever clips. A19: the mouse
            selection hint shares this slot and OUTRANKS the notice. */}
        {showHint ? (
          <Box flexDirection="row" flexShrink={1} overflow="hidden">
            <Text color={t.color.accent} wrap="truncate-end">
              {selectionHint}
            </Text>
          </Box>
        ) : showNotice ? (
          <Box flexDirection="row" flexShrink={1} overflow="hidden">
            <Text color={noticeColor(notice!.level, t)} wrap="truncate-end">
              {notice!.text}
            </Text>
          </Box>
        ) : null}
        {/* Pinned essentials — model + context never shrink, always visible.
            model 段徽标化：[model] 键帽感（label 色），ctx 段紧跟。 */}
        <Box flexDirection="row" flexShrink={0}>
          {DEV_CREDITS_MODE ? (
            <Text color={t.color.warn} wrap="truncate-end">
              {' (dev credits)'}
            </Text>
          ) : null}
          {/* A24：模型段可点——打开模型选择器（最明显该可点的状态栏元素） */}
          <Box
            flexShrink={0}
            onClick={(e: { stopImmediatePropagation?: () => void }) => {
              e.stopImmediatePropagation?.()
              onModelClick?.()
            }}
          >
            <Text color={t.color.muted} wrap="truncate-end">
              {' │ '}
              <Text color={t.color.label} bold>{`[${modelText}]`}</Text>
            </Text>
          </Box>
          {ctxLabel ? (
            <Text color={t.color.muted} wrap="truncate-end">
              {' │ '}
              {ctxLabel}
            </Text>
          ) : null}
        </Box>
        {showBar ? (
          <Text color={t.color.muted} wrap="truncate-end">
            {' │ '}
            <Text color={t.color.label}>{'['}</Text>
            {ctxGradientCells(pct, t, bar.length).map((c, i) => (
              <Text key={i} color={c.color}>
                {c.ch}
              </Text>
            ))}
            <Text color={t.color.label}>{']'}</Text>
            {pct != null ? (
              <Text color={barColor}>
                {' '}
                {pct}%
              </Text>
            ) : null}
          </Text>
        ) : null}
        {showBalanceSeg ? (
          // 💰 余额段可点（强制刷新——与 /balance refresh 同链路）；
          // 优先级：低余额 error 红 > stale warn ⚠ > 正常 accent
          onBalanceClick ? (
            <Box
              flexShrink={0}
              onClick={(e: { stopImmediatePropagation?: () => void }) => {
                e.stopImmediatePropagation?.()
                onBalanceClick()
              }}
            >
              <Text color={balanceLow ? t.color.error : balanceStale ? t.color.warn : t.color.accent} wrap="truncate-end">
                {' │ '}
                {balanceLabel}
              </Text>
            </Box>
          ) : (
            <Text color={balanceLow ? t.color.error : balanceStale ? t.color.warn : t.color.accent} wrap="truncate-end">
              {' │ '}
              {balanceLabel}
            </Text>
          )
        ) : null}
        {showUsageSeg ? (
          // 📊 token 区间段可点（轮换 today → 7d → 30d——与 /usage range 同链路）
          onUsageClick ? (
            <Box
              flexShrink={0}
              onClick={(e: { stopImmediatePropagation?: () => void }) => {
                e.stopImmediatePropagation?.()
                onUsageClick()
              }}
            >
              <Text color={t.color.muted} wrap="truncate-end">
                {' │ '}
                {usageLabel}
              </Text>
            </Box>
          ) : (
            <Text color={t.color.muted} wrap="truncate-end">
              {' │ '}
              {usageLabel}
            </Text>
          )
        ) : null}
        {showDuration ? (
          <Text color={t.color.muted} wrap="truncate-end">
            {' │ '}
            <SessionDuration startedAt={sessionStartedAt!} />
          </Text>
        ) : null}
        {showIdle ? (
          <Text color={t.color.muted} wrap="truncate-end">
            {' │ '}
            <IdleSince endedAt={lastTurnEndedAt!} />
          </Text>
        ) : null}
        {showCompressions ? (
          <Text color={t.color.muted} wrap="truncate-end">
            {' │ '}
            <Text color={compressions >= 10 ? t.color.error : compressions >= 5 ? t.color.warn : t.color.muted}>
              cmp {compressions}
            </Text>
          </Text>
        ) : null}
        {showVoice ? (
          // A24：语音段可点（鼠标切换语音模式——onSessionCountClick 同款模式）
          onVoiceClick ? (
            <Box
              flexShrink={0}
              onClick={(e: { stopImmediatePropagation?: () => void }) => {
                e.stopImmediatePropagation?.()
                onVoiceClick()
              }}
            >
              <Text
                color={
                  voiceLabel!.startsWith('●') ? t.color.error : voiceLabel!.startsWith('◉') ? t.color.warn : t.color.accent
                }
                wrap="truncate-end"
              >
                {' │ '}
                {voiceLabel}
              </Text>
            </Box>
          ) : (
            <Text
              color={
                voiceLabel!.startsWith('●') ? t.color.error : voiceLabel!.startsWith('◉') ? t.color.warn : t.color.muted
              }
              wrap="truncate-end"
            >
              {' │ '}
              {voiceLabel}
            </Text>
          )
        ) : null}
        {showBattery ? (
          <Text
            color={
              battery?.category === 'critical'
                ? t.color.statusCritical
                : battery?.category === 'bad'
                  ? t.color.statusBad
                  : battery?.category === 'warn'
                    ? t.color.statusWarn
                    : t.color.muted
            }
            wrap="truncate-end"
          >
            {' │ '}
            {batteryLabel}
          </Text>
        ) : null}
        {showSessionCount ? sessionCountNode : null}
        {showCostSeg ? (
          <Text color={t.color.muted} wrap="truncate-end">
            {' │ '}
            {costText}
          </Text>
        ) : null}
        {showDevCredits ? (
          <Text color={t.color.accent} wrap="truncate-end">
            {' │ '}
            {devCreditsText}
          </Text>
        ) : null}
        {showConfigEntry ? (
          <Box
            flexShrink={0}
            onClick={(e: { stopImmediatePropagation?: () => void }) => {
              e.stopImmediatePropagation?.()
              onConfigClick!()
            }}
          >
            <Text color={t.color.accent}>{' ⚙'}</Text>
          </Box>
        ) : null}
        {/* SpawnHud isn't part of the tail budget (its width is dynamic), so it
            renders last — any overflow truncates the HUD itself rather than the
            budgeted segments before it. It self-hides when no delegation runs. */}
        <SpawnHud t={t} />
      </Box>

      {rightWidth > 0 ? (
        <>
          <Text color={t.color.border}>{separatorWidth >= 3 ? ' ─ ' : ' '}</Text>
          {/* A24：cwd/标题段可点——打开目录选择器（浏览/切换工作目录） */}
          <Box
            flexShrink={0}
            width={rightWidth}
            onClick={(e: { stopImmediatePropagation?: () => void }) => {
              e.stopImmediatePropagation?.()
              onCwdClick?.()
            }}
          >
            <Text color={t.color.label} wrap="truncate-end">
              {/* A7：会话标题优先于 cwd（参考 rightLabel 同款——标题即当前工作上下文） */}
              {sessionTitle || cwdLabel}
            </Text>
          </Box>
        </>
      ) : null}
    </Box>
  )
}

interface StatusRuleProps {
  /** A7：电池状态（无电池/不可用 → null，段自动隐藏） */
  battery?: BatteryInfo | null
  /** 余额段标签（💰 前缀已含；未配置 → undefined，段隐藏） */
  balanceLabel?: string
  /** 余额最近一次拉取失败（⚠ 着色） */
  balanceStale?: boolean
  /** 余额低于预警阈值（红——一眼可见钱快没了） */
  balanceLow?: boolean
  lastTurnEndedAt?: null | number
  liveSessionCount: number
  busy: boolean
  cols: number
  cwdLabel: string
  /** A7：会话标题（状态条右侧标签，参考同款——有标题时替代 cwd 显示） */
  sessionTitle?: string
  model: string
  modelFast?: boolean
  modelReasoningEffort?: string
  indicatorStyle?: IndicatorStyle
  notice?: Notice | null
  /** A19：鼠标辅助提示（选中/悬停/复制反馈）——优先于 notice 与 status。 */
  selectionHint?: null | string
  sessionStartedAt?: null | number
  showCost: boolean
  status: string
  statusColor: string
  t: Theme
  turnStartedAt?: null | number
  usage: Usage
  /** token 区间段标签（📊 前缀已含） */
  usageLabel?: string
  voiceLabel?: string
  /** 权限模式徽章标签（[MANUAL] 键帽——空闲槽位渲染，语义 tone 着色） */
  permLabel?: string
  permTone?: 'accent' | 'error' | 'good' | 'muted' | 'warn'
  /** 左缘情绪宠物节点（BlackHolePet——简约挂载点，5 列 + 1 空格保留） */
  pet?: ReactNode
  /** P2：配置面板固定入口（⚙ 尾段可点——右分栏直达） */
  onConfigClick?: () => void
  onSessionCountClick?: () => void
  /** 余额段点击（强制刷新） */
  onBalanceClick?: () => void
  /** token 区间段点击（轮换 today/7d/30d） */
  onUsageClick?: () => void
  /** A24：语音段点击（鼠标切换语音模式——onSessionCountClick 同款模式） */
  onVoiceClick?: () => void
  /** A24：右侧 cwd/标题段点击（打开目录选择器——浏览/切换工作目录） */
  onCwdClick?: () => void
  /** A24：模型段点击（打开模型选择器） */
  onModelClick?: () => void
}
