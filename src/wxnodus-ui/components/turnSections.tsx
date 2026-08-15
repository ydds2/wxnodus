// src/wxnodus-ui/components/turnSections.tsx — 阶段 6：回合分区展示（计划/活动/修改/验证/证据）
// 参考同类型 CLI 的成熟做法，只吸收交互规律：
//  - Claude Code：紧凑单行工具摘要 + 清单勾选 + per-file diff 统计
//  - Codex CLI：工具生命周期状态与耗时
//  - Aider：低噪声一行式变更摘要 + 可展开 hunk
//  - Kimi/Gemini：计划/执行分段、阶段状态可见
// 硬约束（本 UI 重构红线）：
//  - 验证/证据只能显示真实验证事件的状态；无事件时诚实显示「等待真实验证事件」，
//    绝不把工具成功、助手文案或 todo 完成渲染成「已验证」。
//  - 单栏：所有分区在同一主列内纵向排列；宽度用 cols 计算。
import { Box, Text } from '@wxnodus/ink'
import { memo, useState } from 'react'

import { useAtom as useStore } from '../../app/stores/engine.js'
import { useTurnSelector } from '../runtime/flowStore.js'
import { usePresentationSelector } from '../runtime/presentationStore.js'
import { evidenceOverall } from '../runtime/evidenceModel.js'
import { $uiState } from '../runtime/viewStore.js'
import { countPendingTodos } from '../lib/liveProgress.js'
import { todoGlyph, todoTone } from '../lib/todo.js'
import { changesLabel, diffSummary } from '../lib/diffSummary.js'
import { ACTIVITY_LABELS, SECTION_EMPTY, SECTION_TITLES } from '../lib/uiCopy.js'
import type { Theme } from '../theme.js'

import { InlineHint, SectionHeader, SingleColumnPanel, StatusBadge } from './uiPrimitives.js'

// ── 计划分区（PlanSection）───────────────────────────────────────────────
// 清单勾选样式（todoGlyph：[x]/[ ]/[!]）+ 完成计数。
// 折叠规则（对齐计划约定）：存在未完成项时默认展开；全部完成/取消时默认收起。
const PlanSection = memo(function PlanSection({ t }: { t: Theme }) {
  const todos = useTurnSelector(s => s.todos)
  // null = 跟随默认规则；显式点击后遵循用户选择
  const [userCollapsed, setUserCollapsed] = useState<null | boolean>(null)

  if (!todos.length) {
    return null
  }

  const done = todos.filter(x => x.status === 'completed').length
  const pending = countPendingTodos(todos)
  const defaultCollapsed = pending === 0
  const collapsed = userCollapsed ?? defaultCollapsed

  return (
    <Box flexDirection="column" marginBottom={1}>
      <SectionHeader
        collapsed={collapsed}
        onToggle={() => setUserCollapsed(v => !(v ?? defaultCollapsed))}
        right={`${done}/${todos.length}`}
        t={t}
        title={SECTION_TITLES.plan}
        tone={pending > 0 ? 'warn' : 'neutral'}
      />
      {!collapsed && (
        <SingleColumnPanel>
          {todos.map(todo => (
            <Box key={todo.id}>
              <Text
                color={todoTone(todo.status) === 'dim' ? t.color.muted : t.color.text}
                dim={todoTone(todo.status) === 'dim'}
              >
                {todoGlyph(todo.status)} {todo.content}
              </Text>
            </Box>
          ))}
        </SingleColumnPanel>
      )}
    </Box>
  )
})

// ── 活动分区（ActivitySection）────────────────────────────────────────────
// 紧凑单行摘要：运行中工具（名称/上下文）+ 已完成计数；完整工具记录仍在
// MessageLine 的 ToolTrail 里（不重复渲染——低噪声）。
const ActivitySection = memo(function ActivitySection({ t }: { t: Theme }) {
  const activeTools = useTurnSelector(s => s.tools)
  const turnTrail = useTurnSelector(s => s.turnTrail)

  if (!activeTools.length && !turnTrail.length) {
    return null
  }

  const running = activeTools.map(tool => (tool.context ? `${tool.name}(${tool.context})` : tool.name)).join(' · ')

  return (
    <Box flexDirection="column" marginBottom={1}>
      <SectionHeader t={t} title={SECTION_TITLES.activity} />
      <SingleColumnPanel>
        {running ? <InlineHint t={t} text={`${running} · ${ACTIVITY_LABELS.running}`} /> : null}
        {turnTrail.length > 0 ? <InlineHint t={t} text={ACTIVITY_LABELS.completed(turnTrail.length)} /> : null}
      </SingleColumnPanel>
    </Box>
  )
})

// ── 修改分区（ChangesSection）────────────────────────────────────────────
// `修改 N 个文件 · +A -D` 摘要行；点击展开 per-file 行与 diff 正文
// （+/- 行着色：diffAdded/diffRemoved——主题既有语义色）。
const ChangesSection = memo(function ChangesSection({ t }: { t: Theme }) {
  const segments = useTurnSelector(s => s.streamSegments)
  const summary = diffSummary(segments)
  const [expanded, setExpanded] = useState(false)

  if (!summary.files.length) {
    return null
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <SectionHeader
        collapsed={!expanded}
        onToggle={() => setExpanded(v => !v)}
        right={changesLabel(summary)}
        t={t}
        title={SECTION_TITLES.changes}
      />
      {expanded && (
        <SingleColumnPanel>
          {summary.files.map(f => (
            <Box flexDirection="column" key={f.path}>
              <Text color={t.color.label} wrap="truncate-end">
                {f.path} <Text color={t.color.diffAddedWord}>+{f.added}</Text>{' '}
                <Text color={t.color.diffRemovedWord}>-{f.removed}</Text>
              </Text>
              {f.body.split('\n').map((line, i) => {
                const color = line.startsWith('+') && !line.startsWith('+++')
                  ? t.color.diffAdded
                  : line.startsWith('-') && !line.startsWith('---')
                    ? t.color.diffRemoved
                    : t.color.muted

                return (
                  <Text color={color} key={i} wrap="truncate-end">
                    {line || ' '}
                  </Text>
                )
              })}
            </Box>
          ))}
        </SingleColumnPanel>
      )}
    </Box>
  )
})

// ── 验证分区（VerificationSection）───────────────────────────────────────
// 数据源：presentationStore.evidence（只接受 verification.* 事件）。
// 无事件时诚实显示「等待真实验证事件 · 待验证」——绝不渲染成已验证。
const VerificationSection = memo(function VerificationSection({ t }: { t: Theme }) {
  const items = usePresentationSelector(s => s.evidence.items)
  const entries = Object.values(items)

  if (!entries.length) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <SectionHeader t={t} title={SECTION_TITLES.verification} />
        <SingleColumnPanel>
          <InlineHint t={t} text={`${SECTION_EMPTY.noVerificationEvents} · 待验证`} />
        </SingleColumnPanel>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <SectionHeader right={`${entries.length} 项`} t={t} title={SECTION_TITLES.verification} />
      <SingleColumnPanel>
        {entries.map(item => (
          <Box flexDirection="row" flexShrink={1} key={item.id} overflow="hidden">
            <StatusBadge status={item.status} t={t} />
            <Text color={t.color.muted} wrap="truncate-end">
              {' '}
              {item.summary}
              {item.artifactRef ? ` · ${item.artifactRef}` : ''}
              {item.failedReason ? ` · ${item.failedReason}` : ''}
            </Text>
          </Box>
        ))}
      </SingleColumnPanel>
    </Box>
  )
})

// ── 证据分区（EvidenceSection）───────────────────────────────────────────
// 只有真实证据项存在时才渲染（低噪声）；整体状态用 evidenceOverall 汇总。
const EvidenceSection = memo(function EvidenceSection({ t }: { t: Theme }) {
  const items = usePresentationSelector(s => s.evidence.items)
  const entries = Object.values(items)

  if (!entries.length) {
    return null
  }

  const overall = evidenceOverall({ items })

  return (
    <Box flexDirection="column" marginBottom={1}>
      <SectionHeader
        right={<StatusBadge status={overall} t={t} />}
        t={t}
        title={SECTION_TITLES.evidence}
        tone={overall === 'verified' ? 'neutral' : overall === 'failed' ? 'error' : 'warn'}
      />
      <SingleColumnPanel>
        {entries.map(item => (
          <Text color={t.color.muted} key={item.id} wrap="truncate-end">
            {item.id} · {item.summary}
            {item.sourceEvent ? ` · 来源 ${item.sourceEvent}` : ''}
          </Text>
        ))}
      </SingleColumnPanel>
    </Box>
  )
})

// ── 回合分区总装 ─────────────────────────────────────────────────────────
// 渲染规则（诚实 + 低噪声）：
//  - 计划/活动/修改：有真实数据才渲染（数据来自 turnState）。
//  - 验证：busy 时渲染（诚实显示待验证）；回合结束且无真实事件则不渲染（不留噪声）。
//  - 证据：只有真实证据项存在时才渲染。
export const TurnSections = memo(function TurnSections({ cols }: { cols: number }) {
  const ui = useStore($uiState)
  const evidenceItems = usePresentationSelector(s => s.evidence.items)
  const hasEvidence = Object.keys(evidenceItems).length > 0

  if (!ui.busy && !hasEvidence) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1} width={Math.max(1, cols - 2)}>
      <PlanSection t={ui.theme} />
      <ActivitySection t={ui.theme} />
      <ChangesSection t={ui.theme} />
      {ui.busy || hasEvidence ? <VerificationSection t={ui.theme} /> : null}
      {hasEvidence ? <EvidenceSection t={ui.theme} /> : null}
    </Box>
  )
})
