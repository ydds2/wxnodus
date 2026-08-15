// src/wxnodus-ui/components/detailPane.tsx — A23 双栏布局：右侧详情面板
// 设计：四标签（清单/工具/上下文/子代理）——鼠标点击 + Alt+1-4（meta+数字，与
//       Alt+D/Alt+G 同款便携修饰键，不抢普通数字输入）；✕ 关闭；ScrollBox 跟随底部。
//       全部数据来自现有 store（$turnState / $uiState）——零新数据源、零假数据。
//       固定宽度由 lib/paneLayout.dualPaneWidths 分配（右栏固定、左栏弹性）。
import { Box, Text, useInput, ScrollBox } from '@wxnodus/ink'
import { memo, useEffect, useMemo, useState } from 'react'
import { useAtom as useStore } from '../../app/stores/engine.js'

import { dualPaneWidths, PANE_TAB_LABEL, PANE_TABS } from '../lib/paneLayout.js'
import { boundedLiveRenderText, compactPreview, fmtK, formatToolCall, parseToolTrailResultLine } from '../lib/text.js'
import { buildSubagentTree, flattenTree, fmtDuration, formatSummary, sparkline, treeTotals, widthByDepth } from '../lib/subagentTree.js'
import { FEATURE_SPOTLIGHTS } from '../content/features.js'
import { toggleTodoCollapsed, useTurnSelector } from '../runtime/flowStore.js'
import { bgActiveCount, useBgSelector } from '../runtime/backgroundStore.js'
import { patchUiState, $uiState } from '../runtime/viewStore.js'
import type { Theme } from '../theme.js'
import type { PaneTab } from '../types.js'

import { TodoPanel } from './todoPanel.js'
import { icon } from '../glyphs.js'

// 子代理状态 glyph（与 agentsOverlay STATUS_GLYPH 同语义——紧凑版）
const SUB_GLYPH: Record<string, { color: (t: Theme) => string; glyph: string }> = {
  running: { color: t => t.color.accent, glyph: '●' },
  queued: { color: t => t.color.muted, glyph: '○' },
  completed: { color: t => t.color.statusGood, glyph: icon('check') },
  interrupted: { color: t => t.color.warn, glyph: '■' },
  failed: { color: t => t.color.error, glyph: icon('cross') },
  timeout: { color: t => t.color.warn, glyph: icon('hourglass') },
  error: { color: t => t.color.error, glyph: icon('warn') },
}

const fmtElapsed = (ms: number) => {
  const sec = Math.max(0, ms) / 1000

  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

const ctxBarColor = (pct: number | undefined, t: Theme): string => {
  if (pct == null) return t.color.muted
  if (pct >= 95) return t.color.statusCritical
  if (pct > 80) return t.color.statusBad
  if (pct >= 50) return t.color.statusWarn
  return t.color.statusGood
}

const ctxBar = (pct: number | undefined, w = 10): string => {
  if (pct == null) return '░'.repeat(w)
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))

  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

export const DetailPane = memo(function DetailPane({ cols, onCommand }: { cols: number; onCommand?: (text: string) => void }) {
  const ui = useStore($uiState)
  const t = ui.theme
  const paneWidth = dualPaneWidths(cols).right
  const innerWidth = Math.max(20, paneWidth - 2)

  // Alt+1-6（meta+数字）切换标签——不抢普通数字输入（与 Alt+D/Alt+G 同款模式）
  useInput((ch, key) => {
    if (!key.meta) {
      return
    }
    const n = parseInt(ch, 10)

    if (n >= 1 && n <= PANE_TABS.length) {
      patchUiState({ paneTab: PANE_TABS[n - 1]! })
    }
  })

  return (
    <Box
      borderColor={t.color.border}
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      marginLeft={1}
      width={paneWidth + 2}
    >
      {/* 头部：标题 + 关闭 */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text bold color={t.color.accent}>
          ⛶ 详情
        </Text>
        {/* A22 鼠标化：✕ 关闭（onClick 模式） */}
        <Box onClick={() => patchUiState({ dualPane: false })}>
          <Text color={t.color.muted}>{icon('close')}</Text>
        </Box>
      </Box>

      {/* 标签行：鼠标点击 + Alt+1-4 */}
      <Box flexDirection="row" paddingX={1}>
        {PANE_TABS.map((tab, i) => (
          <Box key={tab} onClick={() => patchUiState({ paneTab: tab })}>
            <Text bold={ui.paneTab === tab} color={ui.paneTab === tab ? t.color.accent : t.color.muted}>
              {ui.paneTab === tab ? '▸ ' : '  '}
              {i + 1}.{PANE_TAB_LABEL[tab]}
            </Text>
          </Box>
        ))}
      </Box>

      <Text color={t.color.border}>{'─'.repeat(paneWidth + 2)}</Text>

      <ScrollBox flexDirection="column" flexGrow={1} paddingX={1} stickyScroll>
        <PaneTabView innerWidth={innerWidth} onCommand={onCommand} tab={ui.paneTab} t={t} />
      </ScrollBox>

      <Text color={t.color.muted} dim>
        {' '}
        Alt+1-{PANE_TABS.length} 切换 · Alt+D 开关
      </Text>
    </Box>
  )
})

// ── 标签视图 ─────────────────────────────────────────────────────────

function PaneTabView({
  innerWidth,
  onCommand,
  tab,
  t
}: {
  innerWidth: number
  onCommand?: (text: string) => void
  tab: PaneTab
  t: Theme
}) {
  switch (tab) {
    case 'todo':
      return <TodoTab innerWidth={innerWidth} t={t} />
    case 'tools':
      return <ToolsTab innerWidth={innerWidth} t={t} />
    case 'context':
      return <ContextTab innerWidth={innerWidth} t={t} />
    case 'subagents':
      return <SubagentsTab innerWidth={innerWidth} t={t} />
    case 'bg':
      return <BgTab t={t} />
    case 'features':
      return <FeaturesTab onCommand={onCommand} t={t} />
  }
}

function EmptyHint({ text, t }: { text: string; t: Theme }) {
  return (
    <Text color={t.color.muted} dim>
      {text}
    </Text>
  )
}

// ── 清单：复用 TodoPanel（面板接管——内联 LiveTodoPanel 已隐藏）────────

function TodoTab({ innerWidth: _innerWidth, t }: { innerWidth: number; t: Theme }) {
  const todos = useTurnSelector(s => s.todos)
  const todoCollapsed = useTurnSelector(s => s.todoCollapsed)

  if (!todos.length) {
    return <EmptyHint t={t} text="无进行中任务——复杂请求会自动生成任务清单" />
  }

  return <TodoPanel collapsed={todoCollapsed} onToggle={toggleTodoCollapsed} t={t} todos={todos} />
}

// ── 工具：当前执行 + 已完成调用链（点击展开 Args/Result）──────────────

function ToolsTab({ innerWidth, t }: { innerWidth: number; t: Theme }) {
  const activeTools = useTurnSelector(s => s.tools)
  const trail = useTurnSelector(s => s.turnTrail)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  // 有进行中工具时 500ms 刷新耗时（unref 防测试挂起——TodoPanel 同款）
  useEffect(() => {
    if (!activeTools.length) {
      return
    }
    const id = setInterval(() => setNow(Date.now()), 500)
    id.unref?.()

    return () => clearInterval(id)
  }, [activeTools.length])

  const toggle = (key: string) =>
    setOpen(prev => {
      const next = new Set(prev)

      if (next.has(key)) next.delete(key)
      else next.add(key)

      return next
    })

  const rows: Array<{ key: string; mark?: string; label: string; detail: string; startedAt?: number }> = []

  for (const tool of activeTools) {
    rows.push({
      key: `active:${tool.id}`,
      label: formatToolCall(tool.name, tool.context),
      detail: tool.verboseArgs ?? '',
      startedAt: tool.startedAt,
    })
  }

  for (const [i, line] of trail.entries()) {
    const parsed = parseToolTrailResultLine(line)

    if (parsed) {
      rows.push({ key: `tr:${i}`, mark: parsed.mark === '✗' ? icon('cross') : icon('check'), label: parsed.call, detail: parsed.detail })
    }
  }

  if (!rows.length) {
    return <EmptyHint t={t} text="尚无工具调用——agent 执行工具时这里实时展示" />
  }

  return (
    <Box flexDirection="column">
      {rows.map(row => {
        const expanded = open.has(row.key)

        return (
          <Box flexDirection="column" key={row.key}>
            {/* A22 鼠标化：点击行展开/收起详情（Args/Result） */}
            <Box onClick={() => row.detail && toggle(row.key)}>
              <Text color={row.mark === '✗' ? t.color.error : t.color.text} wrap="truncate-end">
                <Text color={row.mark === '✗' ? t.color.error : row.mark ? t.color.statusGood : t.color.accent}>
                  {row.mark === '✗' ? `${icon('cross')} ` : row.mark ? `${icon('check')} ` : `${icon('circleF')} `}
                </Text>
                {row.label}
                {row.startedAt ? <Text color={t.color.statusFg} dim>{` (${fmtElapsed(now - row.startedAt)})`}</Text> : null}
              </Text>
            </Box>
            {expanded && row.detail ? (
              <Text color={t.color.muted} wrap="truncate-end">
                {'  '}
                {compactPreview(boundedLiveRenderText(row.detail), innerWidth - 4)}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

// ── 上下文：token 用量条 + 模型/会话/状态 ────────────────────────────

function ContextTab({ innerWidth, t }: { innerWidth: number; t: Theme }) {
  const ui = useStore($uiState)
  const usage = ui.usage

  const pct =
    usage.context_percent ??
    (usage.context_max && usage.context_used != null
      ? Math.round((usage.context_used / usage.context_max) * 100)
      : undefined)

  const fmt = (n?: number) => (n == null || n <= 0 ? '—' : fmtK(n))

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={ctxBarColor(pct, t)}>{ctxBar(pct, Math.max(8, Math.min(innerWidth - 2, 16)))}</Text>
        <Text color={t.color.muted} dim>
          {' '}
          {pct == null ? '未上报' : `${pct}%`}
          {usage.context_used != null ? ` · ${fmtK(usage.context_used)}` : ''}
          {usage.context_max ? `/${fmtK(usage.context_max)}` : ''}
        </Text>
      </Text>
      <Text color={t.color.muted} wrap="truncate-end">
        {' '}
        输入 {fmt(usage.input)} · 输出 {fmt(usage.output)} · 总计 {fmt(usage.total)}
      </Text>
      {usage.reasoning && usage.reasoning > 0 ? (
        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
          推理 {fmt(usage.reasoning)}
        </Text>
      ) : null}
      {usage.calls ? (
        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
          调用 {usage.calls} 次{usage.compressions ? ` · 压缩 ${usage.compressions} 次` : ''}
        </Text>
      ) : null}
      {ui.showCost && usage.cost_usd ? (
        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
          成本 ${usage.cost_usd.toFixed(4)}
        </Text>
      ) : null}
      <Text color={t.color.border}>{'─'.repeat(Math.min(innerWidth, 24))}</Text>
      {ui.info?.model ? (
        <Text color={t.color.text} wrap="truncate-end">
          {' '}
          模型 {ui.info.model}
        </Text>
      ) : null}
      {ui.sid ? (
        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
          会话 {ui.sid}
        </Text>
      ) : null}
      <Text color={ui.busy ? t.color.accent : t.color.muted} wrap="truncate-end">
        {' '}
        {ui.busy ? `● ${ui.status}` : `○ ${ui.status}`}
      </Text>
    </Box>
  )
}

// ── 子代理：汇总行 + 紧凑状态树 ──────────────────────────────────────

function SubagentsTab({ innerWidth, t }: { innerWidth: number; t: Theme }) {
  const subagents = useTurnSelector(s => s.subagents)
  const tree = useMemo(() => buildSubagentTree(subagents), [subagents])
  const totals = useMemo(() => treeTotals(tree), [tree])
  const spark = useMemo(() => (tree.length ? sparkline(widthByDepth(tree)) : ''), [tree])
  const flat = useMemo(() => flattenTree(tree), [tree])

  if (!flat.length) {
    return <EmptyHint t={t} text="尚无子代理——/delegate 或 /goal 派发后这里实时展示" />
  }

  return (
    <Box flexDirection="column">
      <Text color={t.color.text} wrap="truncate-end">
        {' '}
        {formatSummary(totals)}
        {spark ? <Text color={t.color.muted} dim>{`  ${spark}`}</Text> : null}
      </Text>
      <Text color={t.color.border}>{'─'.repeat(Math.min(innerWidth, 24))}</Text>
      {flat.map(node => {
        const g = SUB_GLYPH[node.item.status] ?? SUB_GLYPH.error!
        const prefix = node.item.taskCount > 1 ? `[${node.item.index + 1}/${node.item.taskCount}] ` : ''

        return (
          <Text key={node.item.id} color={t.color.muted} wrap="truncate-end">
            {' '}
            <Text color={g.color(t)}>{g.glyph}</Text>
            {'  '.repeat(Math.max(0, node.item.depth))}
            {prefix}
            {compactPreview(node.item.goal || 'subagent', innerWidth - 6 - node.item.depth * 2)}
            {node.item.status === 'running' && node.item.startedAt ? (
              <Text color={t.color.statusFg} dim>
                {' '}
                {fmtDuration(Math.max(0, (Date.now() - node.item.startedAt) / 1000))}
              </Text>
            ) : null}
          </Text>
        )
      })}
    </Box>
  )
}

// ── 后台：终端 / 后台任务 / 定时任务 / 目标循环 ───────────────────────

const JOB_GLYPH: Record<string, { color: (t: Theme) => string; glyph: string }> = {
  queued: { color: t => t.color.muted, glyph: '○' },
  running: { color: t => t.color.accent, glyph: '●' },
  success: { color: t => t.color.statusGood, glyph: icon('check') },
  done: { color: t => t.color.statusGood, glyph: icon('check') },
  failed: { color: t => t.color.error, glyph: icon('cross') },
  cancelled: { color: t => t.color.muted, glyph: '−' },
}

function BgTab({ t }: { t: Theme }) {
  const bg = useBgSelector(s => s)
  const running = bgActiveCount(bg)

  if (!bg.terms.length && !bg.jobs.length && !bg.cron.length && !bg.goal?.active) {
    return (
      <Box flexDirection="column">
        <EmptyHint t={t} text="暂无后台活动——/term 开终端、/jobs 跑任务、/goal 目标循环、/cron 定时任务都会显示在这里" />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {running > 0 ? (
        <Text color={t.color.accent} wrap="truncate-end">
          {' '}
          {icon('copy')} {running} 项后台活动进行中
        </Text>
      ) : null}

      {/* 目标循环 */}
      {bg.goal?.active ? (
        <Box flexDirection="column">
          <Text color={t.color.accent} wrap="truncate-end">
            {' '}
            {icon('target')} goal 第 {bg.goal.round}/{bg.goal.maxRounds} 轮
          </Text>
          {bg.goal.text ? (
            <Text color={t.color.muted} wrap="truncate-end">
              {'  '}
              {bg.goal.text}
            </Text>
          ) : null}
          <Text color={t.color.border}>{'─'.repeat(16)}</Text>
        </Box>
      ) : null}

      {/* 后台终端 */}
      {bg.terms.length ? (
        <Box flexDirection="column">
          <Text bold color={t.color.text} wrap="truncate-end">
            {' '}
            终端（{bg.terms.filter(x => x.status === 'running').length} 运行中）
          </Text>
          {bg.terms.slice(0, 6).map(term => (
            <Text key={term.id} color={t.color.muted} wrap="truncate-end">
              {' '}
              <Text color={term.status === 'running' ? t.color.accent : t.color.muted}>
                {term.status === 'running' ? '●' : '○'}
              </Text>{' '}
              {compactPreview(term.shell, 12)}
              <Text color={t.color.statusFg} dim>{` · ${compactPreview(term.cwd, innerShort(term.cwd))}`}</Text>
            </Text>
          ))}
          <Text color={t.color.border}>{'─'.repeat(16)}</Text>
        </Box>
      ) : null}

      {/* 后台任务 */}
      {bg.jobs.length ? (
        <Box flexDirection="column">
          <Text bold color={t.color.text} wrap="truncate-end">
            {' '}
            任务（{bg.jobs.filter(j => j.status === 'running' || j.status === 'queued').length} 进行中）
          </Text>
          {bg.jobs.slice(0, 6).map(job => {
            const g = JOB_GLYPH[job.status] ?? JOB_GLYPH.failed!

            return (
              <Text key={job.id} color={t.color.muted} wrap="truncate-end">
                {' '}
                <Text color={g.color(t)}>{g.glyph}</Text> {compactPreview(job.goal || job.kind, 26)}
                {job.status === 'running' ? <Text color={t.color.statusFg} dim>{` · ${job.kind}`}</Text> : null}
              </Text>
            )
          })}
          <Text color={t.color.border}>{'─'.repeat(16)}</Text>
        </Box>
      ) : null}

      {/* 定时任务 */}
      {bg.cron.length ? (
        <Box flexDirection="column">
          <Text bold color={t.color.text} wrap="truncate-end">
            {' '}
            定时任务
          </Text>
          {bg.cron.slice(0, 6).map(c => (
            <Text key={c.id} color={t.color.muted} wrap="truncate-end">
              {' '}
              <Text color={c.enabled ? t.color.accent : t.color.muted}>{c.enabled ? '●' : '○'}</Text>{' '}
              {compactPreview(c.schedule, 12)}
              <Text color={t.color.statusFg} dim>{` · ${compactPreview(c.action, 18)}`}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

// 终端 cwd 短显示（面板内一行的预算）
const innerShort = (p: string) => Math.max(8, 18 - Math.min(p.length, 18))

// ── 特色：WxNodus 旗舰能力速览（点击执行示例命令）────────────────────
// 内容单一事实来源：content/features.ts（与 intro SessionPanel 特色能力区共用）

function FeaturesTab({ onCommand, t }: { onCommand?: (text: string) => void; t: Theme }) {
  return (
    <Box flexDirection="column">
      <Text color={t.color.muted} dim>
        {' '}
        WxNodus 旗舰能力——点击行执行示例命令
      </Text>
      {FEATURE_SPOTLIGHTS.map(f => (
        // A22 鼠标化：点击执行（与补全面板提交同链路）；
        // 平铺单 Text——嵌套 Text 在窄面板 truncate 宽度测量不稳（命令行优先完整）
        <Box flexDirection="column" key={f.label} onClick={() => onCommand?.(f.cmd)}>
          <Text wrap="truncate-end">{` ${f.label} — ${f.cmd}`}</Text>
          <Text color={t.color.muted} dim wrap="truncate-end">
            {`   ${f.desc}`}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
