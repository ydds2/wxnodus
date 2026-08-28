// src/wxnodus-ui/components/workspaceView.tsx — P1 工作台渲染（2026-08-20）
// status/doctor 结构化工作台视图：标题 + 分节 kv 行（语义 tone 着色）+ 底部键位提示。
// 数据来自 rpc/workspaceRpc.ts（gateway 内核端口 ∪ TUI 状态合并），渲染纯展示无状态。
import { Box, Text } from '@wxnodus/ink'

import type { WorkspaceData, WorkspaceKind, WorkspaceRow } from '../bridge/interfaces.js'
import type { Theme } from '../theme.js'
import { icon } from '../glyphs.js'

const toneColor = (tone: WorkspaceRow['tone'] | undefined, t: Theme) =>
  tone === 'ok' ? t.color.statusGood : tone === 'warn' ? t.color.warn : tone === 'bad' ? t.color.error : t.color.muted

export function WorkspaceView({
  data,
  onClose,
  t,
  ws
}: {
  data: WorkspaceData
  ws: WorkspaceKind
  t: Theme
  onClose?: () => void
}) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} width={72}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={t.color.accent}>
          {icon('diamond')} {data.title}
        </Text>
        <Box onClick={onClose}>
          <Text color={t.color.muted}>{icon('close')}</Text>
        </Box>
      </Box>
      <Text color={t.color.border}>{'─'.repeat(68)}</Text>
      {data.sections.map((sec, i) => (
        <Box flexDirection="column" key={i} marginTop={i ? 1 : 0}>
          <Text bold color={t.color.label}>
            {sec.label}
          </Text>
          {sec.rows.map((r, j) => (
            <Box flexDirection="row" key={j}>
              <Text color={t.color.muted}>{`  ${r.k.padEnd(10)}`}</Text>
              <Text color={toneColor(r.tone, t)} wrap="truncate-end">
                {r.v}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box flexDirection="row" marginTop={1}>
        <Text color={t.color.muted}>
          {ws === 'status' ? 'w 切换体检' : 'w 切换状态'} · Esc 关闭（全局统一出栈）
        </Text>
      </Box>
    </Box>
  )
}
