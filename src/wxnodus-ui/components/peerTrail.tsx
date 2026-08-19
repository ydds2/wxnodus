// src/wxnodus-ui/components/peerTrail.tsx — 工具调用渲染（2026-08-19 全面替换：
// 对标 Claude Code / Codex / Gemini CLI 同族输出格式）
// 规则：每工具 = 一行 dim「• Name(短参)」（执行中旋转帧）＋ dim 缩进结果
// （≤6 行截断）；失败红色；无边框、无 ✓/✗ 装饰、无时长、无 chevron 折叠。
// 参考锚点：Claude Code 工具行「⏺ Bash(npm test)」+ dim 输出；Gemini CLI 同构。
import { Box, Text } from '@wxnodus/ink'
import { memo, type ReactNode } from 'react'

import {
  compactPreview,
  formatToolCall,
  isTransientTrailLine,
  parseToolTrailResultLine,
  splitToolDuration
} from '../lib/text.js'
import type { Theme } from '../theme.js'
import type { ActiveTool } from '../types.js'

import { icon } from '../glyphs.js'
import { Spinner } from './thinking.js'

/** 工具结果最大展示行数（超长截断——对标 Claude Code dim 输出但有界） */
const RESULT_MAX_LINES = 6

const truncLines = (s: string, max = RESULT_MAX_LINES) => {
  const lines = s.split('\n')
  if (lines.length <= max) return s
  return `${lines.slice(0, max).join('\n')}\n…（${lines.length - max} 行省略）`
}

/** 工具调用单行：• Name(短参)——时长剥离（噪声），失败红色 */
export function PeerToolCallLine({
  call,
  error,
  t
}: {
  call: string
  error?: boolean
  t: Theme
}) {
  const { label } = splitToolDuration(call)
  const color = error ? t.color.error : t.color.muted

  return (
    <Text color={color} wrap="truncate-end">
      {icon('bullet')} {label}
    </Text>
  )
}

/** 工具结果：dim 缩进文本（≤6 行），失败红色 */
export function PeerToolResultLine({
  detail,
  error,
  t
}: {
  detail: string
  error?: boolean
  t: Theme
}) {
  const text = compactPreview(truncLines(detail), 240)
  if (!text) return null

  return (
    <Box marginLeft={2}>
      <Text color={error ? t.color.error : t.color.muted} dimColor wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}

/** 完整工具轨迹：已完成调用（trail 行）+ 进行中调用（activeTools） */
export const PeerToolTrail = memo(function PeerToolTrail({
  t,
  tools = [],
  trail = []
}: {
  t: Theme
  tools?: ActiveTool[]
  trail?: string[]
}) {
  const rows: ReactNode[] = []

  for (const [i, line] of trail.entries()) {
    const parsed = parseToolTrailResultLine(line)

    if (parsed) {
      const error = parsed.mark === '✗'
      rows.push(
        <Box flexDirection="column" key={`c${i}`}>
          <PeerToolCallLine call={parsed.call} error={error} t={t} />
          {parsed.detail ? <PeerToolResultLine detail={parsed.detail} error={error} t={t} /> : null}
        </Box>
      )

      continue
    }

    // 过渡行（drafting…/analyzing…）——纯噪声，直接丢弃
    if (isTransientTrailLine(line)) {
      continue
    }

    rows.push(
      <Text color={t.color.muted} dimColor key={`m${i}`}>
        {line}
      </Text>
    )
  }

  for (const tool of tools) {
    rows.push(
      <Box flexDirection="row" key={tool.id}>
        <Text color={t.color.muted}>
          <Spinner color={t.color.accent} variant="tool" />{' '}
        </Text>
        <Text color={t.color.muted} wrap="truncate-end">
          {formatToolCall(tool.name, tool.context ?? '')}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows}
    </Box>
  )
})
