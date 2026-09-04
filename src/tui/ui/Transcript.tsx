// src/tui/ui/Transcript.tsx — 转录流：左边条消息（▎用户蓝/▎助手绿）+ 工具行 + 通知/错误
// + 视口钳制（钉底核心）：转录区行数预算 = 终端行 − 底部固定区；↑↓/PgUp/PgDn 翻历史，0 = 贴底跟随。
// 降噪默认（原型 54 实证规则）：工具一行（名+关键参数+耗时）·详情折叠·thinking 只心跳。
// 渲染口径：全部经 markdown-lite 自行硬换行（行数可预测——不依赖 ink wrap，钉底不漂移）。
import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { TuiStore, type ChatEntry, type ToolEntry } from '../store.js'
import { DEEP_SPACE } from '../theme.js'
import { glyphs } from '../termcap.js'
import { renderMarkdownLite, type Line } from '../markdown.js'
import { sliceViewport, sliceViewportFromTop, wrapText } from '../viewport.js'
import { useStableInput } from './stableInput.js'
import { tuiT } from '../i18n.js'

/** 每条目渲染行缓存（WeakMap：条目对象不可变替换时命中缓存；GC 安全） */
interface EntryLines { cols: number; lines: Line[] }
const lineCache = new WeakMap<object, EntryLines>()

function segsOf(entry: ChatEntry, cols: number, bar: string): Line[] {
  const cached = lineCache.get(entry)
  // 运行中的工具行/子代理行含 spinner 帧——不缓存（帧间动画）；其余条目对象不可变，命中即复用
  const animating = (entry.kind === 'tool' && entry.tool?.phase === 'run')
    || (entry.kind === 'agents' && (entry.agents ?? []).some(a => a.phase === 'run'))
  if (!animating && cached && cached.cols === cols) return cached.lines

  let lines: Line[]
  if (entry.kind === 'tool' && entry.tool) {
    lines = toolLines(entry.tool, cols)
  } else if (entry.kind === 'user' || entry.kind === 'assistant') {
    const color = entry.kind === 'user' ? DEEP_SPACE.accent : DEEP_SPACE.success
    // 视觉评审 P1（2026-09-04 帧取证）：user/assistant 前缀均为 ▎ 无法辨角色——
    // user 用 ❯（prompt 符·accent），assistant 保持 ▎（bar 符·success）——宽度等宽 1，行高预算不变
    const lead = (entry.kind === 'user' ? glyphs().prompt : bar) + ' '
    const base = renderMarkdownLite(entry.text ?? '', cols - 2)
    lines = base.map(l => ({ kind: l.kind, segs: [{ text: lead, color }, ...l.segs] }))
  } else if (entry.kind === 'notice') {
    lines = wrapText(entry.text ?? '', cols - 2).map(t => ({ kind: 'normal' as const, segs: [{ text: '· ' + t, color: DEEP_SPACE.dim }] }))
  } else if (entry.kind === 'error') {
    // 错误行 + 出路提示（原型 12 已落地：错误码分类 → 一行人话出路；重试进度 T34 销项——◈ 重连倒数）
    const msgLines = wrapText(entry.text ?? '', cols - 2).map(t => ({ kind: 'normal' as const, segs: [{ text: '✗ ' + t, color: DEEP_SPACE.error }] }))
    if (entry.errorHint) {
      msgLines.push({ kind: 'normal', segs: [{ text: tuiT('tui.transcript.errorHintPrefix') + entry.errorHint, color: DEEP_SPACE.dim }] })
    }
    lines = msgLines
  } else if (entry.kind === 'fold') {
    lines = wrapText(`${glyphs().fold} ${entry.fold?.label ?? ''}`, cols - 2).map(t => ({ kind: 'normal' as const, segs: [{ text: t, color: DEEP_SPACE.dim }] }))
  } else if (entry.kind === 'agents') {
    // 子代理编排块（原型 23）：状态点 + 目标摘要 + 终态（左缩进，无卡片框）
    lines = (entry.agents ?? []).map(a => {
      const g = a.phase === 'run' ? glyphs().spinner[Math.floor(Date.now() / 120) % glyphs().spinner.length]!
        : a.phase === 'fail' ? '✗' : '✓'
      const color = a.phase === 'run' ? DEEP_SPACE.violet : a.phase === 'fail' ? DEEP_SPACE.error : DEEP_SPACE.success
      const status = a.phase === 'run' ? tuiT('tui.transcript.agentRunning')
        : a.phase === 'fail' ? tuiT('tui.transcript.agentFailed')
        : tuiT('tui.transcript.agentDone', { n: a.turns ?? 0 })
      const goalText = a.goal.length > cols - 30 ? `${a.goal.slice(0, cols - 31)}…` : a.goal
      return {
        kind: 'normal' as const,
        segs: [
          { text: '  ' + g + ' ', color },
          { text: goalText, color: DEEP_SPACE.fg },
          { text: '  ', color: DEEP_SPACE.dim },
          { text: status, color: a.phase === 'fail' ? DEEP_SPACE.error : DEEP_SPACE.dim },
        ],
      }
    })
  } else {
    lines = wrapText(entry.text ?? '', cols - 2).map(t => ({ kind: 'normal' as const, segs: [{ text: t, color: DEEP_SPACE.dim }] }))
  }
  // ⅩⅩⅧ（用户反馈「过密眼花」）：条目尾加一空行——条目间呼吸感；空行计入行缓存
  // （sliceViewport/预算按 lineCache.length 计数——钉底不漂移）。
  if (lines.length > 0 && lines[lines.length - 1]!.segs.length > 0) {
    // 单空格而非空串——ink 会修剪纯空尾行（钉底「整树=终端行数」不变量的关键，与 filler 同法）
    lines.push({ kind: 'normal', segs: [{ text: ' ' }] })
  }
  lineCache.set(entry, { cols, lines })
  return lines
}

/** 工具行：状态符 + 名 + 关键参数 + 耗时；详情（expanded）经 diff 染色管线渲染 */
function toolLines(tool: ToolEntry, cols: number): Line[] {
  const glyph = tool.phase === 'run' ? glyphs().spinner[Math.floor(Date.now() / 120) % glyphs().spinner.length]!
    : tool.phase === 'fail' ? '✗' : '✓'
  const color = tool.phase === 'run' ? DEEP_SPACE.violet : tool.phase === 'fail' ? DEEP_SPACE.error : DEEP_SPACE.success
  const ms = tool.ms ? ` · ${tool.ms < 1000 ? `${tool.ms}ms` : `${(tool.ms / 1000).toFixed(1)}s`}` : ''
  // 摘要硬截断到行宽（行数可预测——钉底不漂移；降噪规则 1：名 + 1 个关键参数）
  const budget = Math.max(12, cols - 2 - tool.name.length - 2 - ms.length)
  const summary = tool.summary && tool.summary.length > budget ? `${tool.summary.slice(0, budget)}…` : tool.summary
  const head: Line = {
    kind: 'normal',
    segs: [
      { text: glyph, color },
      { text: ' ' },
      { text: tool.name, color: DEEP_SPACE.accent },
      ...(summary ? [{ text: ' ' + summary, color: DEEP_SPACE.muted }] : []),
      ...(ms ? [{ text: ms, color: DEEP_SPACE.dim }] : []),
    ],
  }
  if (!tool.expanded || !tool.detail) return [head]
  const detail = renderMarkdownLite(tool.detail, Math.max(8, cols - 4))
  return [head, ...detail.map(l => ({ kind: l.kind, segs: [{ text: '  ' }, ...l.segs] }))]
}

/** 全量行数（键位处理器用——快输入下从 store 快照现算；segsOf 有 WeakMap 缓存，帧间零重算） */
function totalLinesOf(entries: ChatEntry[], cols: number): number {
  return entries.reduce((a, e) => a + segsOf(e, cols, glyphs().bar).length, 0)
}

export function Transcript({ store, entries, thinking, retry, command, cols, maxRows }: {
  store: TuiStore
  entries: ChatEntry[]
  thinking: { ms: number; toks: number; stage?: string } | null
  retry: { attempt: number; max: number; delayMs: number; at: number } | null
  command: { text: string; ms: number } | null
  cols: number
  maxRows: number
}): React.ReactElement {
  const s = store.getSnapshot()
  const pinned = s.scroll.pinnedLine
  const slashOpen = s.composer.value.startsWith('/')
  const overlayOpen = s.overlay.kind !== 'none'

  // 全量行计划（WeakMap 缓存——帧间零重算；运行中工具行绕过缓存以驱动 spinner）
  const plans = useMemo(() => entries.map(e => segsOf(e, cols, glyphs().bar)), [entries, cols])
  const linesByEntry = useMemo(() => new Map<ChatEntry, Line[]>(entries.map((e, i) => [e, plans[i]!])), [entries, plans])

  // 行数预算：thinking 心跳 1 行 + 命令心跳 1 行 + 上下标记各 1 行
  const thinkingRows = thinking ? 1 : 0
  const commandRows = command ? 1 : 0
  const budget = Math.max(1, maxRows - thinkingRows - commandRows - 2)

  // 顶锚定钳制（视图重建/转录收缩后 pinned 可能越界——渲染时收口）
  const totalLines = plans.reduce((a, p) => a + p.length, 0)
  const maxTop = Math.max(0, totalLines - budget)
  const clamped = pinned === null ? null : Math.min(pinned, maxTop)

  const sliced = useMemo(() => clamped === null
    ? sliceViewport(entries, e => (lineCache.get(e)?.lines.length ?? 1), budget, 0)
    : sliceViewportFromTop(entries, e => (lineCache.get(e)?.lines.length ?? 1), budget, clamped),
  [entries, budget, clamped])

  useStableInput((_input, key) => {
    if (overlayOpen || slashOpen) return // 焦点让位：浮层/斜杠菜单自消费
    // 快输入下从 store 快照现算（闭包捕获渲染时值会丢字——Composer 同款教训）
    const snap = store.getSnapshot()
    const curPinned = snap.scroll.pinnedLine
    const curTop = curPinned ?? Math.max(0, totalLinesOf(snap.entries, cols) - budget)
    const curMax = Math.max(0, totalLinesOf(snap.entries, cols) - budget)
    if (key.pageUp) { store.setPinnedLine(Math.max(0, curTop - Math.max(3, budget - 1))); return }
    if (key.pageDown) { store.scrollToBottom(); return }
    if (key.upArrow) { store.setPinnedLine(Math.max(0, curTop - 3)); return }
    if (key.downArrow) {
      if (curPinned === null) return // 贴底跟随态：↓ 无操作
      const next = curPinned + 3
      if (next >= curMax) store.scrollToBottom() // 回底即重新跟随（新内容贴底）
      else store.setPinnedLine(next)
      return
    }
  })

  const hiddenBelow = Math.max(0, sliced.hiddenBelow)

  // 实际渲染行数（条目 + 标记 + 心跳）——用于底部填充：转录区占满窗口，输入框常驻窗口底部
  const usedRows = (sliced.hiddenAbove > 0 ? 1 : 0)
    + sliced.items.reduce((a, it) => a + Math.max(0, it.toLine - it.fromLine), 0)
    + thinkingRows
    + commandRows
    + (hiddenBelow > 0 ? 1 : 0)
  const filler = Math.max(0, maxRows - usedRows)

  return (
    <Box flexDirection="column" flexGrow={0}>
      {sliced.hiddenAbove > 0 ? (
        <Text color={DEEP_SPACE.dim}>{tuiT('tui.transcript.hiddenAbove', { n: sliced.hiddenAbove })}</Text>
      ) : null}
      {sliced.items.map((it, i) => {
        const allLines = linesByEntry.get(it.entry) ?? []
        const lines = allLines.slice(it.fromLine, it.toLine)
        return (
          <Box key={i} flexDirection="column">
            {lines.map((l, j) => (
              <Text key={j}>
                {l.segs.map((seg, k) => (
                  <Text key={k} color={seg.color} bold={seg.bold ?? undefined}>{seg.text}</Text>
                ))}
              </Text>
            ))}
          </Box>
        )
      })}
      {thinking ? (
        <Text color={DEEP_SPACE.dim}>
          {retry ? (
            <Text color={DEEP_SPACE.violet}>
              {tuiT('tui.transcript.reconnecting', { a: retry.attempt, m: retry.max, s: Math.max(0, Math.ceil((retry.delayMs - (Date.now() - retry.at)) / 1000)) })}
            </Text>
          ) : thinking.stage ? (
            <Text color={DEEP_SPACE.violet}>◈ {thinking.stage}</Text>
          ) : (
            <Text>Thinking···</Text>
          )}
          {' · '}{Math.round(thinking.ms / 1000)}s · {thinking.toks} chunks
        </Text>
      ) : null}
      {command ? (
        <Text color={DEEP_SPACE.violet}>{tuiT('tui.transcript.commandRunning', { cmd: command.text.slice(0, 60), s: Math.round(command.ms / 1000) })}</Text>
      ) : null}
      {hiddenBelow > 0 ? (
        <Text color={DEEP_SPACE.dim}>{tuiT('tui.transcript.hiddenBelow', { n: hiddenBelow })}</Text>
      ) : null}
      {/* 底部填充：转录区占满 maxRows——内容不足时空白让位，输入框+参数行恒落窗口底部 */}
      {filler > 0 ? (
        <Box flexDirection="column">
          {Array.from({ length: filler }, (_, i) => <Text key={`fill${i}`}>{' '}</Text>)}
        </Box>
      ) : null}
    </Box>
  )
}
