// src/tui/ui/Header.tsx — 顶部品牌条：三明治边界框架的上沿（WXNODUS 字标 + 会话徽章行）
// 边界词汇：上下双细线包夹（#2a3050）——界面整体结构的明确锚点（用户反馈：整体边界未体现）。
import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '@wxnodus/ink'
import { TuiStore } from '../store.js'
import { DEEP_SPACE } from '../theme.js'
import { glyphs } from '../termcap.js'

function line(width: number): string { return '─'.repeat(Math.max(0, width - 1)) }

export function Header({ store }: { store: TuiStore }): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const cols = process.stdout.columns ?? 80
  const g = glyphs()
  const runningMark = s.running
    ? <Text color={DEEP_SPACE.violet}>{g.spinner[Math.floor(Date.now() / 120) % g.spinner.length]!} 回合中</Text>
    : <Text color={DEEP_SPACE.dim}>空闲</Text>
  return (
    <Box flexDirection="column">
      <Text color="#2a3050">{line(cols)}</Text>
      <Box>
        <Text>
          <Text color={DEEP_SPACE.accent} bold> WXNODUS </Text>
          <Text color={DEEP_SPACE.dim}>TUI</Text>
          <Text color={DEEP_SPACE.dim}>{'  '}│{'  '}</Text>
          {runningMark}
          <Text color={DEEP_SPACE.dim}>{'  '}│{'  '}</Text>
          <Text color={DEEP_SPACE.muted}>{s.mode} · {s.model}</Text>
          {s.gitBranch ? <Text color={DEEP_SPACE.dim}> · {s.gitBranch}</Text> : null}
        </Text>
      </Box>
      <Text color="#2a3050">{line(cols)}</Text>
    </Box>
  )
}
