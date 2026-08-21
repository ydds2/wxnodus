// src/wxnodus-ui/output/tui.tsx — V4 L0-3：RenderBlock → ink 渲染器（TUI 后端）
//
// 消费 spec.ts 的后端无关中间表示；本文件不决定任何形态/颜色语义（那是 spec 的职责）——
// 只做 ink 映射：语义色 → ThemeColors、折叠交互（统一 FoldHeader）、流式标记。
// 折叠统一协议（docs/output-spec-v1.md §4）：▸/▾ 标题 (计数) + 点击/Ctrl+O 切换，
// reasoning / 工具结果全文 / 长输出 / diff 四类共用。
import { Box, Text } from '@wxnodus/ink'
import { memo, useState, type ReactNode } from 'react'

import type { Theme } from '../theme.js'
import type { FoldPolicy, RenderBlock } from './spec.js'

/** 语义色 → 主题色（spec 主题无关；此处唯一映射点） */
function themeColorOf(c: RenderBlock['color'], t: Theme): string {
  switch (c) {
    case 'accent': return t.color.accent
    case 'error': return t.color.error
    case 'warn': return t.color.warn
    case 'ok': return t.color.ok
    case 'muted': return t.color.muted
    case 'text': return t.color.text
  }
}

export interface FoldHeaderProps {
  fold: FoldPolicy
  /** 折叠体内容（展开时渲染，限高由调用方/滚动区负责） */
  children?: ReactNode
  t: Theme
}

/** 统一折叠头（四类折叠共用）：▸/▾ 标题 (badge)，点击切换 */
export const FoldHeader = memo(function FoldHeader({ fold, children, t }: FoldHeaderProps) {
  const [open, setOpen] = useState(!fold.collapsed)
  return (
    <Box flexDirection="column">
      <Box onClick={() => setOpen(v => !v)}>
        <Text color={t.color.muted}>{open ? '▾ ' : '▸ '}</Text>
        <Text color={t.color.muted}>{fold.title}</Text>
        <Text color={t.color.muted} dimColor> ({fold.badge})</Text>
      </Box>
      {open && children ? <Box marginLeft={2}>{children}</Box> : null}
    </Box>
  )
})

export interface BlockViewProps {
  block: RenderBlock
  /** 折叠体渲染（tool-result 全文 / command 长输出 / reasoning 全文） */
  foldedBody?: ReactNode
  t: Theme
}

/** 单渲染块 → ink（fold 块经 FoldHeader 统一交互） */
export const BlockView = memo(function BlockView({ block, foldedBody, t }: BlockViewProps) {
  const color = themeColorOf(block.color, t)
  const head = (
    <Box marginLeft={block.indent}>
      <Text color={color} {...(block.dim ? { dimColor: true } : {})}>
        {block.glyph}
        {block.streaming ? `${block.text}…` : block.text}
      </Text>
    </Box>
  )
  if (block.fold) {
    return (
      <Box flexDirection="column">
        <FoldHeader fold={block.fold} t={t}>
          {foldedBody ?? (
            <Text color={color} dimColor wrap="truncate-end">{block.text}</Text>
          )}
        </FoldHeader>
      </Box>
    )
  }
  return head
})

/** 渲染块序列（messageLine 切片分支消费；assistant/diff 等正文块由调用方特化） */
export const BlockListView = memo(function BlockListView({ blocks, t, foldedBodies }: {
  blocks: RenderBlock[]
  t: Theme
  foldedBodies?: ReactNode[]
}) {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} t={t} foldedBody={foldedBodies?.[i]} />
      ))}
    </Box>
  )
})
