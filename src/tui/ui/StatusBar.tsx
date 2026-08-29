// src/tui/ui/StatusBar.tsx — 状态栏：模式(模型●) · cwd · git · tip 轮换（kimi 底栏机制，实现原创）
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiState } from '../store.js'
import { DEEP_SPACE } from '../theme.js'

export function StatusBar({ state }: { state: TuiState }): React.ReactElement {
  const cwd = state.cwd.length > 24 ? `…${state.cwd.slice(-22)}` : state.cwd
  return (
    <Box marginTop={0} flexDirection="column">
      <Text color={DEEP_SPACE.muted}>
        <Text color={DEEP_SPACE.accent}>[{state.mode}]</Text>
        {' '}
        <Text>({state.model} {state.running ? <Text color={DEEP_SPACE.violet}>●</Text> : '○'})</Text>
        {'  '}
        <Text>{cwd}</Text>
        {state.gitBranch ? <Text color={DEEP_SPACE.dim}> {state.gitBranch}</Text> : null}
        {state.running ? <Text color={DEEP_SPACE.dim}> · 回合运行中</Text> : null}
        {'  '}
        <Text color={DEEP_SPACE.dim}>{DEEP_SPACE.tips[state.tipIdx]!}</Text>
      </Text>
      <Text color="#2a3050">{'─'.repeat(Math.max(0, (process.stdout.columns ?? 80) - 1))}</Text>
    </Box>
  )
}
