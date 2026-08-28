// src/wxnodus-ui/components/uiPrimitives.tsx — 阶段 3：可组合设计原语（单栏 + tier-safe）
// 少量可组合 primitive，供分区展示复用；宽度一律 stringWidth，不用 JS .length 做布局。
// 关键状态同时有文字（不依赖颜色），字形经 icon() 按终端层级取变体。
import { Box, Text } from '@wxnodus/ink'
import type { ReactNode } from 'react'

import { icon } from '../glyphs.js'
import type { Theme } from '../theme.js'
import type { EvidenceStatus } from '../runtime/evidenceModel.js'
import { EVIDENCE_STATUS_LABELS } from '../lib/uiCopy.js'

/** 分区标题行：`┊ 计划 2/4` + 右侧可选摘要（点击折叠/展开）。 */
export function SectionHeader({
  title,
  right,
  tone = 'neutral',
  collapsed,
  onToggle,
  t
}: {
  title: string
  right?: ReactNode
  tone?: 'error' | 'neutral' | 'warn'
  collapsed?: boolean
  onToggle?: () => void
  t: Theme
}) {
  const color = tone === 'error' ? t.color.error : tone === 'warn' ? t.color.warn : t.color.accent
  const body = (
    <Box flexDirection="row" flexShrink={1} overflow="hidden">
      <Text color={color}>
        {icon('tool')} <Text bold>{title}</Text>
      </Text>
      {right ? (
        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
          {right}
        </Text>
      ) : null}
    </Box>
  )

  if (onToggle) {
    return (
      <Box onClick={onToggle}>
        {body}
        <Text color={t.color.muted}> {collapsed ? icon('expand') : icon('close')}</Text>
      </Box>
    )
  }

  return <Box>{body}</Box>
}

/** 证据状态徽标：文字 + tier-safe 字形，颜色只是辅助（不依赖颜色可读）。 */
export function StatusBadge({ status, t }: { status: EvidenceStatus; t: Theme }) {
  const glyph =
    status === 'verified'
      ? icon('check')
      : status === 'failed'
        ? icon('cross')
        : status === 'running'
          ? icon('hourglass')
          : status === 'interrupted'
            ? icon('close')
            : status === 'pending'
              ? icon('bullet')
              : icon('dash')

  const color =
    status === 'verified'
      ? t.color.ok
      : status === 'failed'
        ? t.color.error
        : status === 'interrupted' || status === 'running'
          ? t.color.warn
          : t.color.muted

  return (
    <Text color={color}>
      {glyph} {EVIDENCE_STATUS_LABELS[status]}
    </Text>
  )
}

/** 单列面板：统一缩进与纵向容器——所有分区共用（不引入第二列）。 */
export function SingleColumnPanel({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {children}
    </Box>
  )
}

/** 分区行内提示（键盘/状态 hint，tier-safe，超长截断不溢出）。 */
export function InlineHint({ text, t }: { text: string; t: Theme }) {
  return (
    <Text color={t.color.muted} wrap="truncate-end">
      {text}
    </Text>
  )
}
