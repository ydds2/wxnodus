// subagentAccordion.tsx — 子代理树手风琴（V4 UI 重构：自 thinking.tsx 拆出 ~500 行）
// 树渲染辅助（TreeRow/TreeTextRow/TreeNode/Chevron/heatColor/fmtElapsed/导轨函数）随迁；
// thinking 保留 Spinner/Detail/StreamCursor/Thinking/ToolTrail。导出：SubagentAccordion。
import { Box, NoSelect, Text } from '@wxnodus/ink'
import { type ReactNode, useEffect, useState } from 'react'
import type { SubagentNode } from '../types.js'
import type { Theme } from '../theme.js'
import type { TreeRails, TreeBranch } from './treeRails.js'
import { hotnessBucket, fmtCost, fmtTokens } from '../lib/subagentTree.js'
import { compactPreview } from '../lib/text.js'
// 环治理（2026-08-28 完整 TUI 恢复）：thinking↔accordion 运行时环改依赖反转——renderThinking
// 道具由 thinking.tsx 注入 <Thinking/>，本组件不回指 thinking 模块。

export const fmtElapsed = (ms: number) => {
  const sec = Math.max(0, ms) / 1000

  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}


const nextTreeRails = (rails: TreeRails, branch: TreeBranch) => [...rails, branch === 'mid']

// A20 精简：rails 为空时平铺（无缩进树）——工具组传 []，子代理树保留层级
const treeLead = (rails: TreeRails, branch: TreeBranch) =>
  rails.length ? `${rails.map(on => (on ? '│ ' : '  ')).join('')}${branch === 'mid' ? '├─ ' : '└─ '}` : ''

// ── Primitives ───────────────────────────────────────────────────────

export function TreeRow({
  branch,
  children,
  onClick,
  rails = [],
  stemColor,
  stemDim = true,
  t
}: {
  branch: TreeBranch
  children: ReactNode
  onClick?: () => void
  rails?: TreeRails
  stemColor?: string
  stemDim?: boolean
  t: Theme
}) {
  const lead = treeLead(rails, branch)

  return (
    <Box onClick={onClick}>
      <NoSelect flexShrink={0} fromLeftEdge width={lead.length}>
        <Text color={stemColor ?? t.color.muted} dim={stemDim}>
          {lead}
        </Text>
      </NoSelect>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}

export function TreeTextRow({
  branch,
  color,
  content,
  dimColor,
  onClick,
  rails = [],
  t,
  wrap = 'wrap-trim'
}: {
  branch: TreeBranch
  color: string
  content: ReactNode
  dimColor?: boolean
  /** A20：行点击（工具详情折叠展开） */
  onClick?: () => void
  rails?: TreeRails
  t: Theme
  wrap?: 'truncate-end' | 'wrap' | 'wrap-trim'
}) {
  const text = dimColor ? (
    <Text color={color} dim wrap={wrap}>
      {content}
    </Text>
  ) : (
    <Text color={color} wrap={wrap}>
      {content}
    </Text>
  )

  return (
    <TreeRow branch={branch} onClick={onClick} rails={rails} t={t}>
      {text}
    </TreeRow>
  )
}

export function TreeNode({
  branch,
  children,
  header,
  open,
  rails = [],
  stemColor,
  stemDim,
  t
}: {
  branch: TreeBranch
  children?: (rails: boolean[]) => ReactNode
  header: ReactNode
  open: boolean
  rails?: TreeRails
  stemColor?: string
  stemDim?: boolean
  t: Theme
}) {
  return (
    <Box flexDirection="column">
      <TreeRow branch={branch} rails={rails} stemColor={stemColor} stemDim={stemDim} t={t}>
        {header}
      </TreeRow>
      {open ? children?.(nextTreeRails(rails, branch)) : null}
    </Box>
  )
}


export function Chevron({
  count,
  onClick,
  open,
  suffix,
  t,
  title,
  tone = 'dim'
}: {
  count?: number
  onClick: (deep?: boolean) => void
  open: boolean
  suffix?: string
  t: Theme
  title: string
  tone?: 'dim' | 'error' | 'warn'
}) {
  const color = tone === 'error' ? t.color.error : tone === 'warn' ? t.color.warn : t.color.muted

  return (
    <Box onClick={(e: any) => onClick(!!e?.shiftKey || !!e?.ctrlKey)}>
      <Text color={color} dim={tone === 'dim'}>
        <Text color={t.color.accent}>{open ? '▾ ' : '▸ '}</Text>
        {title}
        {typeof count === 'number' ? ` (${count})` : ''}
        {suffix ? (
          <Text color={t.color.statusFg} dim>
            {'  '}
            {suffix}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}

function heatColor(node: SubagentNode, peak: number, theme: Theme): string | undefined {
  const palette = [theme.color.border, theme.color.accent, theme.color.primary, theme.color.warn, theme.color.error]
  const idx = hotnessBucket(node.aggregate.hotness, peak, palette.length)

  // Below the median bucket we keep the default dim stem so cool branches
  // fade into the chrome — only "hot" branches draw the eye.
  if (idx < 2) {
    return undefined
  }

  return palette[idx]
}

export function SubagentAccordion({
  branch,
  expanded,
  node,
  peak,
  rails = [],
  renderThinking,
  t
}: {
  branch: TreeBranch
  expanded: boolean
  node: SubagentNode
  peak: number
  rails?: TreeRails
  renderThinking: (p: { active: boolean; reasoning: string; streaming: boolean; rails: boolean[] }) => ReactNode
  t: Theme
}) {
  const [open, setOpen] = useState(expanded)
  const [deep, setDeep] = useState(expanded)
  const [openThinking, setOpenThinking] = useState(expanded)
  const [openTools, setOpenTools] = useState(expanded)
  const [openNotes, setOpenNotes] = useState(expanded)
  const [openKids, setOpenKids] = useState(expanded)

  useEffect(() => {
    if (!expanded) {
      return
    }

    setOpen(true)
    setDeep(true)
    setOpenThinking(true)
    setOpenTools(true)
    setOpenNotes(true)
    setOpenKids(true)
  }, [expanded])

  const expandAll = () => {
    setOpen(true)
    setDeep(true)
    setOpenThinking(true)
    setOpenTools(true)
    setOpenNotes(true)
    setOpenKids(true)
  }

  const item = node.item
  const children = node.children
  const aggregate = node.aggregate

  const statusTone: 'dim' | 'error' | 'warn' =
    item.status === 'error' || item.status === 'failed'
      ? 'error'
      : item.status === 'interrupted' || item.status === 'timeout'
        ? 'warn'
        : 'dim'

  const prefix = item.taskCount > 1 ? `[${item.index + 1}/${item.taskCount}] ` : ''
  const goalLabel = item.goal || `Subagent ${item.index + 1}`
  const title = `${prefix}${open ? goalLabel : compactPreview(goalLabel, 60)}`
  const summary = compactPreview((item.summary || '').replace(/\s+/g, ' ').trim(), 72)

  // Suffix packs branch rollup: status · elapsed · per-branch tool/agent/token/cost.
  // Emphasises the numbers the user can't easily eyeball from a flat list.
  const statusLabel = item.status === 'queued' ? 'queued' : item.status === 'running' ? 'running' : String(item.status)

  const rollupBits: string[] = [statusLabel]

  if (item.durationSeconds) {
    rollupBits.push(fmtElapsed(item.durationSeconds * 1000))
  }

  const localTools = item.toolCount ?? 0
  const subtreeTools = aggregate.totalTools - localTools

  if (localTools > 0) {
    rollupBits.push(`${localTools} tool${localTools === 1 ? '' : 's'}`)
  }

  const localTokens = (item.inputTokens ?? 0) + (item.outputTokens ?? 0)

  if (localTokens > 0) {
    rollupBits.push(`${fmtTokens(localTokens)} tok`)
  }

  const localCost = item.costUsd ?? 0

  if (localCost > 0) {
    rollupBits.push(fmtCost(localCost))
  }

  const filesLocal = (item.filesWritten?.length ?? 0) + (item.filesRead?.length ?? 0)

  if (filesLocal > 0) {
    rollupBits.push(`⎘${filesLocal}`)
  }

  if (children.length > 0) {
    rollupBits.push(`${aggregate.descendantCount}↓`)

    if (subtreeTools > 0) {
      rollupBits.push(`+${subtreeTools}t sub`)
    }

    const subCost = aggregate.costUsd - localCost

    if (subCost >= 0.01) {
      rollupBits.push(`+${fmtCost(subCost)} sub`)
    }

    if (aggregate.activeCount > 0 && item.status !== 'running') {
      rollupBits.push(`⚡${aggregate.activeCount}`)
    }
  }

  const suffix = rollupBits.join(' · ')

  const thinkingText = item.thinking.join('\n')
  const hasThinking = Boolean(thinkingText)
  const hasTools = item.tools.length > 0
  const noteRows = [...(summary ? [summary] : []), ...item.notes]
  const hasNotes = noteRows.length > 0
  const noteColor = statusTone === 'error' ? t.color.error : statusTone === 'warn' ? t.color.warn : t.color.muted

  const sections: {
    header: ReactNode
    key: string
    open: boolean
    render: (rails: boolean[]) => ReactNode
  }[] = []

  if (hasThinking) {
    sections.push({
      header: (
        <Chevron
          count={item.thinking.length}
          onClick={shift => {
            if (shift) {
              expandAll()
            } else {
              setOpenThinking(v => !v)
            }
          }}
          open={openThinking}
          t={t}
          title="Thinking"
        />
      ),
      key: 'thinking',
      open: openThinking,
      render: childRails => renderThinking({
        active: item.status === 'running',
        reasoning: thinkingText,
        rails: childRails,
        streaming: item.status === 'running'
      })
    })
  }

  if (hasTools) {
    sections.push({
      header: (
        <Chevron
          count={item.tools.length}
          onClick={shift => {
            if (shift) {
              expandAll()
            } else {
              setOpenTools(v => !v)
            }
          }}
          open={openTools}
          t={t}
          title="Tool calls"
        />
      ),
      key: 'tools',
      open: openTools,
      render: childRails => (
        <Box flexDirection="column">
          {item.tools.map((line, index) => (
            <TreeTextRow
              branch={index === item.tools.length - 1 ? 'last' : 'mid'}
              color={t.color.text}
              content={
                <>
                  <Text color={t.color.accent}>● </Text>
                  {line}
                </>
              }
              key={`${item.id}-tool-${index}`}
              rails={childRails}
              t={t}
            />
          ))}
        </Box>
      )
    })
  }

  if (hasNotes) {
    sections.push({
      header: (
        <Chevron
          count={noteRows.length}
          onClick={shift => {
            if (shift) {
              expandAll()
            } else {
              setOpenNotes(v => !v)
            }
          }}
          open={openNotes}
          t={t}
          title="Progress"
          tone={statusTone}
        />
      ),
      key: 'notes',
      open: openNotes,
      render: childRails => (
        <Box flexDirection="column">
          {noteRows.map((line, index) => (
            <TreeTextRow
              branch={index === noteRows.length - 1 ? 'last' : 'mid'}
              color={noteColor}
              content={line}
              dimColor={statusTone === 'dim'}
              key={`${item.id}-note-${index}`}
              rails={childRails}
              t={t}
            />
          ))}
        </Box>
      )
    })
  }

  if (children.length > 0) {
    // Nested grandchildren — rendered recursively via SubagentAccordion,
    // sharing the same keybindings / expand semantics as top-level nodes.
    sections.push({
      header: (
        <Chevron
          count={children.length}
          onClick={shift => {
            if (shift) {
              expandAll()
            } else {
              setOpenKids(v => !v)
            }
          }}
          open={openKids}
          suffix={`d${item.depth + 1} · ${aggregate.descendantCount} total`}
          t={t}
          title="Spawned"
        />
      ),
      key: 'subagents',
      open: openKids,
      render: childRails => (
        <Box flexDirection="column">
          {children.map((child, i) => (
            <SubagentAccordion
              branch={i === children.length - 1 ? 'last' : 'mid'}
              expanded={expanded || deep}
              key={child.item.id}
              node={child}
              peak={peak}
              rails={childRails}
              renderThinking={renderThinking}
              t={t}
            />
          ))}
        </Box>
      )
    })
  }

  // Heatmap: amber→error gradient on the stem when this branch is "hot"
  // (high tools/sec) relative to the whole tree's peak.
  const stem = heatColor(node, peak, t)

  return (
    <TreeNode
      branch={branch}
      header={
        <Chevron
          onClick={shift => {
            if (shift) {
              expandAll()

              return
            }

            setOpen(v => {
              if (!v) {
                setDeep(false)
              }

              return !v
            })
          }}
          open={open}
          suffix={suffix}
          t={t}
          title={title}
          tone={statusTone}
        />
      }
      open={open}
      rails={rails}
      stemColor={stem}
      stemDim={stem == null}
      t={t}
    >
      {childRails => (
        <Box flexDirection="column">
          {sections.map((section, index) => (
            <TreeNode
              branch={index === sections.length - 1 ? 'last' : 'mid'}
              header={section.header}
              key={`${item.id}-${section.key}`}
              open={section.open}
              rails={childRails}
              t={t}
            >
              {section.render}
            </TreeNode>
          ))}
        </Box>
      )}
    </TreeNode>
  )
}

// ── Thinking ─────────────────────────────────────────────────────────
