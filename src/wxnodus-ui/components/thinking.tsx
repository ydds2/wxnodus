// src/wxnodus-ui/components/thinking.tsx — 推理过程折叠块
import { Box, Text } from '@wxnodus/ink'
import { memo, type ReactNode, useEffect, useMemo, useState } from 'react'
import spinners, { type BrailleSpinnerName } from 'unicode-animations'

import { THINKING_COT_MAX } from '../config/limits.js'
import { sectionMode } from '../domain/details.js'
import {
  buildSubagentTree,
  formatSummary as formatSpawnSummary,
  peakHotness,
  sparkline,
  treeTotals,
  widthByDepth
} from '../lib/subagentTree.js'
import {
  boundedLiveRenderText,
  estimateTokensRough,
  fmtK,
  formatToolCall,
  parseToolTrailResultLine,
  pick,
  splitToolDuration,
  thinkingPreview,
  toolTrailLabel
} from '../lib/text.js'
import type { Theme } from '../theme.js'
import { SubagentAccordion, TreeTextRow, TreeRow, TreeNode, Chevron, fmtElapsed } from './subagentAccordion.js'
import type { TreeRails, TreeBranch } from './treeRails.js'
import { icon } from '../glyphs.js'
import type {
  ActiveTool,
  ActivityItem,
  DetailsMode,
  SectionVisibility,
  SubagentProgress,
  ThinkingMode
} from '../types.js'

const THINK: BrailleSpinnerName[] = ['helix', 'breathe', 'orbit', 'dna', 'waverows', 'snake', 'pulse']
const TOOL: BrailleSpinnerName[] = ['cascade', 'scan', 'diagswipe', 'fillsweep', 'rain', 'columns', 'sparkle']

export function Spinner({ color, variant = 'think' }: { color: string; variant?: 'think' | 'tool' }) {
  const spin = useMemo(() => {
    const raw = spinners[pick(variant === 'tool' ? TOOL : THINK)]
    const frames: string[] = raw.frames.map(f => [...f][0] ?? icon('bullet'))

    return { ...raw, frames }
  }, [variant])

  const [frame, setFrame] = useState(0)

  useEffect(() => {
    setFrame(0)
  }, [spin])

  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % spin.frames.length), spin.interval)

    return () => clearInterval(id)
  }, [spin])

  return <Text color={color}>{spin.frames[frame]}</Text>
}

interface DetailRow {
  color: string
  content: ReactNode
  dimColor?: boolean
  key: string
}

function Detail({
  branch = 'last',
  color,
  content,
  dimColor,
  rails = [],
  t
}: DetailRow & { branch?: TreeBranch; rails?: TreeRails; t: Theme }) {
  return <TreeTextRow branch={branch} color={color} content={content} dimColor={dimColor} rails={rails} t={t} />
}

function StreamCursor({
  color,
  dimColor,
  streaming = false,
  visible = false
}: {
  color: string
  dimColor?: boolean
  streaming?: boolean
  visible?: boolean
}) {
  const [on, setOn] = useState(true)

  useEffect(() => {
    if (!visible || !streaming) {
      setOn(true)

      return
    }

    const id = setInterval(() => setOn(v => !v), 420)

    return () => clearInterval(id)
  }, [streaming, visible])

  if (!visible) {
    return null
  }

  return dimColor ? (
    <Text color={color} dim>
      {streaming && on ? '▍' : ' '}
    </Text>
  ) : (
    <Text color={color}>{streaming && on ? '▍' : ' '}</Text>
  )
}

export const Thinking = memo(function Thinking({
  active = false,
  branch = 'last',
  mode = 'truncated',
  rails = [],
  reasoning,
  streaming = false,
  t
}: {
  active?: boolean
  branch?: TreeBranch
  mode?: ThinkingMode
  rails?: TreeRails
  reasoning: string
  streaming?: boolean
  t: Theme
}) {
  const preview = useMemo(() => {
    const raw = thinkingPreview(reasoning, mode, THINKING_COT_MAX)

    return mode === 'full' ? boundedLiveRenderText(raw) : raw
  }, [mode, reasoning])

  const lines = useMemo(() => preview.split('\n').map(line => line.replace(/\t/g, '  ')), [preview])

  if (!preview && !active) {
    return null
  }

  return (
    <TreeRow branch={branch} rails={rails} t={t}>
      <Box flexDirection="column" flexGrow={1}>
        {preview ? (
          mode === 'full' ? (
            lines.map((line, index) => (
              <Text color={t.color.muted} key={index} wrap="wrap-trim">
                {line || ' '}
                {index === lines.length - 1 ? (
                  <StreamCursor color={t.color.muted} streaming={streaming} visible={active} />
                ) : null}
              </Text>
            ))
          ) : (
            <Text color={t.color.muted} wrap="truncate-end">
              {preview}
              <StreamCursor color={t.color.muted} streaming={streaming} visible={active} />
            </Text>
          )
        ) : (
          <Text color={t.color.muted}>
            <StreamCursor color={t.color.muted} streaming={streaming} visible={active} />
          </Text>
        )}
      </Box>
    </TreeRow>
  )
})

// ── ToolTrail ────────────────────────────────────────────────────────

interface Group {
  color: string
  content: ReactNode
  details: DetailRow[]
  key: string
  label: string
  /** A20：完成标记（trail 行 ✓/✗）——渲染在行首，一眼看成败；W8-23 层级感知后为字符串变体 */
  mark?: string
}

export const ToolTrail = memo(function ToolTrail({
  busy = false,
  commandOverride = false,
  detailsMode = 'collapsed',
  outcome = '',
  reasoningActive = false,
  reasoning = '',
  reasoningTokens,
  reasoningStreaming = false,
  sections,
  subagents = [],
  t,
  tools = [],
  toolTokens,
  trail = [],
  activity = []
}: {
  busy?: boolean
  commandOverride?: boolean
  detailsMode?: DetailsMode
  outcome?: string
  reasoningActive?: boolean
  reasoning?: string
  reasoningTokens?: number
  reasoningStreaming?: boolean
  sections?: SectionVisibility
  subagents?: SubagentProgress[]
  t: Theme
  tools?: ActiveTool[]
  toolTokens?: number
  trail?: string[]
  activity?: ActivityItem[]
}) {
  const visible = useMemo(
    () => ({
      thinking: sectionMode('thinking', detailsMode, sections, commandOverride),
      tools: sectionMode('tools', detailsMode, sections, commandOverride),
      subagents: sectionMode('subagents', detailsMode, sections, commandOverride),
      activity: sectionMode('activity', detailsMode, sections, commandOverride)
    }),
    [commandOverride, detailsMode, sections]
  )

  const [now, setNow] = useState(() => Date.now())
  // Local toggles own the open state once mounted.  Init from the resolved
  // section visibility so default-expanded sections (thinking/tools) render
  // open on first paint; the useEffect below re-syncs when the user mutates
  // visibility at runtime via /details.  NEVER OR these against
  // `visible.X === 'expanded'` at render time — that locks the panel open
  // and silently breaks manual chevron clicks for default-expanded
  // sections (regression caught after #14968).
  const [openThinking, setOpenThinking] = useState(visible.thinking === 'expanded')
  const [openTools, setOpenTools] = useState(visible.tools === 'expanded')
  const [openSubagents, setOpenSubagents] = useState(visible.subagents === 'expanded')
  const [deepSubagents, setDeepSubagents] = useState(visible.subagents === 'expanded')
  const [openMeta, setOpenMeta] = useState(visible.activity === 'expanded')
  // A20 精简：工具 Args/Result 详情默认折叠——点击工具行展开
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!tools.length || (visible.tools !== 'expanded' && !openTools)) {
      return
    }

    // A20 修复：500ms → 200ms——亚秒级工具耗时也可见跳动
    const id = setInterval(() => setNow(Date.now()), 200)

    return () => clearInterval(id)
  }, [openTools, tools.length, visible.tools])

  useEffect(() => {
    setOpenThinking(visible.thinking === 'expanded')
    setOpenTools(visible.tools === 'expanded')
    setOpenSubagents(visible.subagents === 'expanded')
    setOpenMeta(visible.activity === 'expanded')
  }, [visible])

  const cot = useMemo(() => thinkingPreview(reasoning, 'full', THINKING_COT_MAX), [reasoning])

  // Spawn-tree derivations must live above any early return so React's
  // rules-of-hooks sees a stable call order.  Cheap O(N) builds memoised
  // by subagent-list identity.
  const spawnTree = useMemo(() => buildSubagentTree(subagents), [subagents])
  const spawnPeak = useMemo(() => peakHotness(spawnTree), [spawnTree])
  const spawnTotals = useMemo(() => treeTotals(spawnTree), [spawnTree])
  const spawnWidths = useMemo(() => widthByDepth(spawnTree), [spawnTree])
  const spawnSpark = useMemo(() => sparkline(spawnWidths), [spawnWidths])
  const spawnSummaryLabel = useMemo(() => formatSpawnSummary(spawnTotals), [spawnTotals])

  if (
    !busy &&
    !trail.length &&
    !tools.length &&
    !subagents.length &&
    !activity.length &&
    !cot &&
    !reasoningActive &&
    !outcome
  ) {
    return null
  }

  // ── Build groups + meta ────────────────────────────────────────

  const groups: Group[] = []
  const meta: DetailRow[] = []
  const pushDetail = (row: DetailRow) => (groups.at(-1)?.details ?? meta).push(row)

  for (const [i, line] of trail.entries()) {
    const parsed = parseToolTrailResultLine(line)

    if (parsed) {
      groups.push({
        color: parsed.mark === '✗' ? t.color.error : t.color.text,
        content: parsed.call,
        details: [],
        key: `tr-${i}`,
        label: parsed.call,
        // A20：✓/✗ 完成标记（此前解析了 mark 却不显示）
        mark: parsed.mark === '✗' ? icon('cross') : icon('check')
      })

      if (parsed.detail) {
        pushDetail({
          color: parsed.mark === '✗' ? t.color.error : t.color.muted,
          content: parsed.detail,
          dimColor: parsed.mark !== '✗',
          key: `tr-${i}-d`
        })
      }

      continue
    }

    if (line.startsWith('drafting ')) {
      const label = toolTrailLabel(line.slice(9).replace(/…$/, '').trim())

      groups.push({
        color: t.color.text,
        content: label,
        details: [{ color: t.color.muted, content: 'drafting...', dimColor: true, key: `tr-${i}-d` }],
        key: `tr-${i}`,
        label
      })

      continue
    }

    // A20 精简：删除 'analyzing tool output…' 过渡行（无信息量噪音）
    meta.push({ color: t.color.muted, content: line, dimColor: true, key: `tr-${i}` })
  }

  for (const tool of tools) {
    const label = formatToolCall(tool.name, tool.context || '')

    groups.push({
      color: t.color.text,
      key: tool.id,
      label,
      details: tool.verboseArgs
        ? [
            {
              color: t.color.muted,
              content: `Args:\n${boundedLiveRenderText(tool.verboseArgs)}`,
              dimColor: true,
              key: `${tool.id}-args`
            }
          ]
        : [],
      content: (
        <>
          <Spinner color={t.color.accent} variant="tool" /> {label}
          {tool.startedAt ? ` (${fmtElapsed(now - tool.startedAt)})` : ''}
        </>
      )
    })
  }

  for (const item of activity.slice(-4)) {
    const glyph = item.tone === 'error' ? icon('cross') : item.tone === 'warn' ? '!' : icon('bullet')
    const color = item.tone === 'error' ? t.color.error : item.tone === 'warn' ? t.color.warn : t.color.muted
    meta.push({ color, content: `${glyph} ${item.text}`, dimColor: item.tone === 'info', key: `a-${item.id}` })
  }

  // ── Derived ────────────────────────────────────────────────────

  const hasTools = groups.length > 0
  const hasSubagents = subagents.length > 0
  const hasMeta = meta.length > 0
  const hasThinking = !!cot || reasoningActive || reasoningStreaming
  const thinkingLive = reasoningActive || reasoningStreaming

  const tokenCount =
    reasoningTokens && reasoningTokens > 0 ? reasoningTokens : reasoning ? estimateTokensRough(reasoning) : 0

  const toolTokenCount = toolTokens ?? 0
  const totalTokenCount = tokenCount + toolTokenCount
  const thinkingTokensLabel = tokenCount > 0 ? `~${fmtK(tokenCount)} tokens` : null

  const toolTokensLabel = toolTokens !== undefined && toolTokens > 0 ? `~${fmtK(toolTokens)} tokens` : undefined

  const totalTokensLabel = tokenCount > 0 && toolTokenCount > 0 ? `~${fmtK(totalTokenCount)} total` : null
  const delegateGroups = groups.filter(g => g.label.startsWith('Delegate Task'))
  const inlineDelegateKey = hasSubagents && delegateGroups.length === 1 ? delegateGroups[0]!.key : null

  const toolLabel = (group: Group) => {
    const { duration, label } = splitToolDuration(String(group.content))

    return duration ? (
      <>
        {label}
        <Text color={t.color.statusFg} dim>
          {duration}
        </Text>
      </>
    ) : (
      group.content
    )
  }

  // ── Backstop: floating alerts when every panel is hidden ─────────
  //
  // Per-section overrides win over the global details_mode (they're computed
  // by sectionMode), so we only collapse to nothing when EVERY section is
  // resolved to hidden — that way `details_mode: hidden` + `sections.tools:
  // expanded` still renders the tools panel.  When all panels are hidden
  // AND ambient errors/warnings exist, surface them as a compact inline
  // backstop so quiet-mode users aren't blind to failures.

  const allHidden =
    visible.thinking === 'hidden' &&
    visible.tools === 'hidden' &&
    visible.subagents === 'hidden' &&
    visible.activity === 'hidden'

  if (allHidden) {
    const alerts = activity.filter(i => i.tone !== 'info').slice(-2)

    return alerts.length ? (
      <Box flexDirection="column">
        {alerts.map(i => (
          <Text color={i.tone === 'error' ? t.color.error : t.color.warn} key={`ha-${i.id}`}>
            {i.tone === 'error' ? icon('cross') : '!'} {i.text}
          </Text>
        ))}
      </Box>
    ) : null
  }

  // ── Tree render fragments ──────────────────────────────────────
  //
  // Shift+click on any chevron expands every NON-hidden section at once —
  // hidden sections stay hidden so the override is honoured.

  const expandAll = () => {
    if (visible.thinking !== 'hidden') {
      setOpenThinking(true)
    }

    if (visible.tools !== 'hidden') {
      setOpenTools(true)
    }

    if (visible.subagents !== 'hidden') {
      setOpenSubagents(true)
      setDeepSubagents(true)
    }

    if (visible.activity !== 'hidden') {
      setOpenMeta(true)
    }
  }

  const metaTone: 'dim' | 'error' | 'warn' = activity.some(i => i.tone === 'error')
    ? 'error'
    : activity.some(i => i.tone === 'warn')
      ? 'warn'
      : 'dim'

  const renderSubagentList = (rails: boolean[]) => (
    <Box flexDirection="column">
      {spawnTree.map((node, index) => (
        <SubagentAccordion
          branch={index === spawnTree.length - 1 ? 'last' : 'mid'}
          expanded={visible.subagents === 'expanded' || deepSubagents}
          key={node.item.id}
          node={node}
          peak={spawnPeak}
          rails={rails}
          t={t}
        />
      ))}
    </Box>
  )

  const panels: {
    header: ReactNode
    key: string
    open: boolean
    render: (rails: boolean[]) => ReactNode
  }[] = []

  if (hasThinking && visible.thinking !== 'hidden') {
    panels.push({
      header: (
        <Box
          onClick={(e: any) => {
            if (e?.shiftKey || e?.ctrlKey) {
              expandAll()
            } else {
              setOpenThinking(v => !v)
            }
          }}
        >
          <Text color={t.color.muted} dim={!thinkingLive}>
            <Text color={t.color.accent}>{openThinking ? '▾ ' : '▸ '}</Text>
            {thinkingLive ? (
              <Text bold color={t.color.text}>
                Thinking
              </Text>
            ) : (
              <Text color={t.color.muted} dim>
                Thinking
              </Text>
            )}
            {thinkingTokensLabel ? (
              <Text color={t.color.statusFg} dim>
                {'  '}
                {thinkingTokensLabel}
              </Text>
            ) : null}
          </Text>
        </Box>
      ),
      key: 'thinking',
      open: openThinking,
      render: rails => (
        <Thinking
          active={reasoningActive}
          branch="last"
          mode="full"
          rails={rails}
          reasoning={busy ? reasoning : cot}
          streaming={busy && reasoningStreaming}
          t={t}
        />
      )
    })
  }

  if (hasTools && visible.tools !== 'hidden') {
    panels.push({
      header: (
        <Chevron
          count={groups.length}
          onClick={shift => {
            if (shift) {
              expandAll()
            } else {
              setOpenTools(v => !v)
            }
          }}
          open={openTools}
          suffix={toolTokensLabel}
          t={t}
          title="Tool calls"
        />
      ),
      key: 'tools',
      open: openTools,
      render: _rails => (
        <Box flexDirection="column">
          {groups.map((group, _index) => {
            const hasInlineSubagents = inlineDelegateKey === group.key
            // Surface the /agents hint the moment a delegate group appears —
            // while it's still in-flight and before any subagent has
            // registered — so users can open the live monitor immediately.
            const isDelegateGroup = group.label.startsWith('Delegate Task')
            // A20 精简：详情默认折叠（点击工具行展开/收起）
            const groupOpen = openGroups.has(group.key)

            return (
              <Box flexDirection="column" key={group.key}>
                <TreeTextRow
                  branch="last"
                  color={group.color}
                  content={
                    <>
                      <Text color={t.color.accent}>● </Text>
                      {group.mark ? (
                        <Text color={group.mark === '✗' ? t.color.error : t.color.ok}>{group.mark} </Text>
                      ) : null}
                      {toolLabel(group)}
                      {isDelegateGroup ? (
                        <Text color={t.color.statusFg} dim>
                          {'  (/agents to monitor)'}
                        </Text>
                      ) : null}
                    </>
                  }
                  onClick={group.details.length ? () => {
                    setOpenGroups(prev => {
                      const next = new Set(prev)

                      if (next.has(group.key)) {
                        next.delete(group.key)
                      } else {
                        next.add(group.key)
                      }

                      return next
                    })
                  } : undefined}
                  rails={[]}
                  t={t}
                />
                {groupOpen
                  ? group.details.map((detail, detailIndex) => (
                      <Detail
                        {...detail}
                        branch={detailIndex === group.details.length - 1 && !hasInlineSubagents ? 'last' : 'mid'}
                        key={detail.key}
                        rails={[]}
                        t={t}
                      />
                    ))
                  : null}
                {hasInlineSubagents ? renderSubagentList([]) : null}
              </Box>
            )
          })}
        </Box>
      )
    })
  }

  if (hasSubagents && !inlineDelegateKey && visible.subagents !== 'hidden') {
    // Spark + summary give a one-line read on the branch shape before
    // opening the subtree.  `/agents` opens the full-screen audit overlay.
    const suffix = spawnSpark ? `${spawnSummaryLabel}  ${spawnSpark}  (/agents)` : `${spawnSummaryLabel}  (/agents)`

    panels.push({
      header: (
        <Chevron
          count={spawnTotals.descendantCount}
          onClick={shift => {
            if (shift) {
              expandAll()
              setDeepSubagents(true)
            } else {
              setOpenSubagents(v => !v)
              setDeepSubagents(false)
            }
          }}
          open={openSubagents}
          suffix={suffix}
          t={t}
          title="Spawn tree"
        />
      ),
      key: 'subagents',
      open: openSubagents,
      render: renderSubagentList
    })
  }

  if (hasMeta && visible.activity !== 'hidden') {
    panels.push({
      header: (
        <Chevron
          count={meta.length}
          onClick={shift => {
            if (shift) {
              expandAll()
            } else {
              setOpenMeta(v => !v)
            }
          }}
          open={openMeta}
          t={t}
          title="Activity"
          tone={metaTone}
        />
      ),
      key: 'meta',
      open: openMeta,
      render: rails => (
        <Box flexDirection="column">
          {meta.map((row, index) => (
            <TreeTextRow
              branch={index === meta.length - 1 ? 'last' : 'mid'}
              color={row.color}
              content={row.content}
              dimColor={row.dimColor}
              key={row.key}
              rails={rails}
              t={t}
            />
          ))}
        </Box>
      )
    })
  }

  const topCount = panels.length + (totalTokensLabel ? 1 : 0)

  return (
    <Box flexDirection="column">
      {panels.map((panel, index) => (
        <TreeNode
          branch={index === topCount - 1 ? 'last' : 'mid'}
          header={panel.header}
          key={panel.key}
          open={panel.open}
          t={t}
        >
          {panel.render}
        </TreeNode>
      ))}
      {totalTokensLabel ? (
        <TreeTextRow
          branch="last"
          color={t.color.statusFg}
          content={
            <>
              <Text color={t.color.accent}>Σ </Text>
              {totalTokensLabel}
            </>
          }
          dimColor
          t={t}
        />
      ) : null}
      {outcome ? (
        <Box marginTop={1}>
          <Text color={t.color.muted} dim>
            · {outcome}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
})
