// src/tui/ui/Transcript.tsx — 转录流：左边条消息系（▎用户蓝/▎助手绿）+ 工具行 + 通知/错误
// 降噪默认（原型 54 实证规则）：工具一行（名+关键参数+耗时）·详情折叠·thinking 只心跳
import React from 'react'
import { Box, Text } from 'ink'
import type { ChatEntry, ToolEntry } from '../store.js'
import { DEEP_SPACE } from '../theme.js'
import { glyphs } from '../termcap.js'

const ToolLine = ({ tool }: { tool: ToolEntry }): React.ReactElement => {
  const glyph = tool.phase === 'run' ? glyphs().spinner[Math.floor(Date.now() / 120) % glyphs().spinner.length]!
    : tool.phase === 'fail' ? '✗' : '✓'
  const color = tool.phase === 'run' ? DEEP_SPACE.violet : tool.phase === 'fail' ? DEEP_SPACE.error : DEEP_SPACE.success
  return (
    <Box paddingLeft={1}>
      <Text>
        <Text color={color}>{glyph}</Text>
        {' '}
        <Text color={DEEP_SPACE.accent}>{tool.name}</Text>
        {tool.summary ? <Text color={DEEP_SPACE.muted}> {tool.summary}</Text> : null}
        {tool.ms ? <Text color={DEEP_SPACE.dim}> · {tool.ms < 1000 ? `${tool.ms}ms` : `${(tool.ms / 1000).toFixed(1)}s`}</Text> : null}
      </Text>
      {tool.expanded && tool.detail ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={DEEP_SPACE.dim}>{tool.detail}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function Transcript({ entries, thinking }: {
  entries: ChatEntry[]
  thinking: { ms: number; toks: number } | null
}): React.ReactElement {
  return (
    <Box flexDirection="column" gap={0}>
      {entries.map((e, i) => {
        switch (e.kind) {
          case 'user':
            return (
              <Box key={i} borderLeft={false} paddingLeft={0} marginY={0}>
                <Box width={1}><Text color={DEEP_SPACE.accent}>{glyphs().bar}</Text></Box>
                <Text wrap="wrap">{e.text}</Text>
              </Box>
            )
          case 'assistant':
            return (
              <Box key={i}>
                <Box width={1}><Text color={DEEP_SPACE.success}>{glyphs().bar}</Text></Box>
                <Text wrap="wrap" color={DEEP_SPACE.fg}>{e.text}</Text>
              </Box>
            )
          case 'tool':
            return e.tool ? <ToolLine key={i} tool={e.tool} /> : null
          case 'notice':
            return <Text key={i} color={DEEP_SPACE.dim}>· {e.text}</Text>
          case 'error':
            return <Text key={i} color={DEEP_SPACE.error}>✗ {e.text}</Text>
          case 'thinking':
            return <Text key={i} color={DEEP_SPACE.dim}>{e.text}</Text>
          case 'fold':
            return <Text key={i} color={DEEP_SPACE.dim}>{glyphs().fold} {e.fold?.label}</Text>
          default:
            return null
        }
      })}
      {thinking ? (
        <Text color={DEEP_SPACE.dim}>Thinking··· · {Math.round(thinking.ms / 1000)}s · {thinking.toks} chunks</Text>
      ) : null}
    </Box>
  )
}
