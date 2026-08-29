// src/tui/ui/Overlays.tsx — 浮层：审批（黄框四级）/澄清/密钥（紫框掩码）/帮助页（原型 05/09/10/11）
// 优先级栈（原型 56）：密钥 > 审批 > 澄清 > 帮助——同时至多一层。
import React, { useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '@wxnodus/ink'
import { TuiStore } from '../store.js'
import { TuiRuntime } from '../runtime.js'
import { DEEP_SPACE } from '../theme.js'

const panel = (color: string) => ({
  borderStyle: 'round' as const,
  borderColor: color as never,
  flexDirection: 'column' as const,
  paddingX: 1,
  marginY: 1,
})

export function Overlays({ store, runtime }: { store: TuiStore; runtime: TuiRuntime }): React.ReactElement | null {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const ov = s.overlay

  if (ov.kind === 'approval') {
    return <ApprovalPanel store={store} />
  }
  if (ov.kind === 'clarify') {
    return <ClarifyPanel store={store} />
  }
  if (ov.kind === 'secret') {
    return <SecretPanel store={store} />
  }
  if (ov.kind === 'help') {
    return <HelpPanel runtime={runtime} />
  }
  return null
}

function ApprovalPanel({ store }: { store: TuiStore }): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const ov = s.overlay
  if (ov.kind !== 'approval') return <Box />
  const p = ov.pending
  useInput((_input, key) => {
    if (key.upArrow) store.patch({ overlay: { kind: 'approval', pending: { ...p, selected: (p.selected + p.choices.length - 1) % p.choices.length } } })
    else if (key.downArrow) store.patch({ overlay: { kind: 'approval', pending: { ...p, selected: (p.selected + 1) % p.choices.length } } })
    else if (key.return) p.resolve(p.choices[p.selected]!.key)
    else if (key.escape) p.resolve('deny')
  })
  return (
    <Box {...panel(DEEP_SPACE.warn)}>
      <Text color={DEEP_SPACE.warn} bold>⚠ {p.title}</Text>
      <Text color={DEEP_SPACE.muted}>$ {p.command}</Text>
      {p.choices.map((c, i) => (
        <Text key={c.key} color={i === p.selected ? DEEP_SPACE.warn : DEEP_SPACE.muted}>
          {i === p.selected ? '▸ ' : '  '}{i + 1} {c.label}{c.key === 'deny' ? '' : ''}
        </Text>
      ))}
      <Text color={DEEP_SPACE.dim}>↑↓ 选择 · Enter 确认 · Esc 拒绝 · 超时 5:00 自动拒绝（fail-closed）</Text>
    </Box>
  )
}

function ClarifyPanel({ store }: { store: TuiStore }): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const ov = s.overlay
  const [typed, setTyped] = useState('')
  if (ov.kind !== 'clarify') return <Box />
  const p = ov.pending
  useInput((input, key) => {
    if (key.return) {
      p.resolve(typed.trim() || p.choices[p.selected] || '')
      return
    }
    if (p.choices.length) {
      if (key.upArrow) { store.patch({ overlay: { kind: 'clarify', pending: { ...p, selected: (p.selected + p.choices.length - 1) % p.choices.length } } }); return }
      if (key.downArrow) { store.patch({ overlay: { kind: 'clarify', pending: { ...p, selected: (p.selected + 1) % p.choices.length } } }); return }
    }
    if (key.backspace || key.delete) { setTyped(v => v.slice(0, -1)); return }
    if (!key.ctrl && !key.meta && !key.escape && input) setTyped(v => v + input)
  })
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>? {p.question}</Text>
      {p.choices.map((c, i) => (
        <Text key={c} color={i === p.selected && !typed ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
          {i === p.selected && !typed ? '▸ ' : '  '}{c}
        </Text>
      ))}
      <Text color={DEEP_SPACE.muted}>答案：{typed || '（Enter 采用选中项）'}</Text>
      <Text color={DEEP_SPACE.dim}>↑↓ 选择 · 直接输入自定义答案 · Enter 提交</Text>
    </Box>
  )
}

function SecretPanel({ store }: { store: TuiStore }): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const ov = s.overlay
  if (ov.kind !== 'secret') return <Box />
  const p = ov.pending
  useInput((input, key) => {
    if (key.return) { p.resolve(p.masked || null); return }
    if (key.escape) { p.resolve(null); return }
    if (key.backspace || key.delete) { store.patch({ overlay: { kind: 'secret', pending: { ...p, masked: p.masked.slice(0, -1) } } }); return }
    if (!key.ctrl && !key.meta && input) store.patch({ overlay: { kind: 'secret', pending: { ...p, masked: p.masked + '•' } } })
  })
  return (
    <Box {...panel(DEEP_SPACE.violet)}>
      <Text color={DEEP_SPACE.violet} bold>{p.kind === 'sudo' ? '🔑 sudo 密码' : '🔑 敏感输入'}</Text>
      <Text color={DEEP_SPACE.muted}>{p.prompt}</Text>
      <Text>  {p.masked}<Text color={DEEP_SPACE.violet}>▏</Text></Text>
      <Text color={DEEP_SPACE.dim}>掩码输入 · 仅入内存保险库（进程即焚）· Enter 提交 · Esc 取消（null → 工具停止）</Text>
    </Box>
  )
}

function HelpPanel({ runtime }: { runtime: TuiRuntime }): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape || key.return) runtime.toggleHelp()
  })
  const cols: Array<[string, Array<[string, string]>]> = [
    ['会话', [['/new /resume', '新会话/恢复'], ['/sessions', '会话列表'], ['/undo', '撤销上一回合'], ['/export', '导出 md/json']]],
    ['模型', [['/model', '目录/切换/自定义'], ['/offline', '离线模型'], ['/thinking', '思维链开关'], ['/status', '运行状态']]],
    ['记忆', [['/memory', '三层管理'], ['/hole', '语义检索'], ['/compact', '压缩'], ['/digest', '手动归档']]],
    ['安全', [['/perm', '权限规则'], ['/sandbox', 'Low IL 沙盒'], ['/audit', '审计链'], ['/security', '注入通道']]],
    ['构建', [['/build', '需求编译'], ['/evidence', '证据链'], ['/doctor', '自检'], ['/bundle', '整包分发']]],
    ['系统', [['/theme', '主题'], ['/config', '配置中心'], ['/usage', '用量成本'], ['/logs', '日志']]],
  ]
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={DEEP_SPACE.accent} paddingX={1} marginY={1}>
      <Text color={DEEP_SPACE.accent} bold>WxNodus 命令手册（63 命令 8 组 · 高频节选）</Text>
      <Box flexDirection="row" gap={4} flexWrap="wrap">
        {cols.map(([group, items]) => (
          <Box key={group} flexDirection="column">
            <Text color={DEEP_SPACE.accent}>◆ {group}</Text>
            {items.map(([cmd, desc]) => (
              <Text key={cmd} color={DEEP_SPACE.muted}><Text color={DEEP_SPACE.fg}>{cmd}</Text> {desc}</Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text color={DEEP_SPACE.dim}>Esc 返回 · 快捷键：Ctrl+X 模式 · Ctrl+T 详情 · Ctrl+S 注入 · Esc Esc 回滚（规划中）</Text>
    </Box>
  )
}
