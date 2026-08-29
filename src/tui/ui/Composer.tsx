// src/tui/ui/Composer.tsx — 输入区：❯ 提示符 + 掩码/明文输入 + 双通道（Enter 发送/排队 · Ctrl+S steer）
// + 斜杠命令菜单（双列过滤——kimi 自绘菜单机制，实现原创）
import React, { useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '@wxnodus/ink'
import { TuiStore } from '../store.js'
import { TuiRuntime } from '../runtime.js'
import { DEEP_SPACE } from '../theme.js'

const PLACEHOLDER_BUSY = 'Prrrrr... Enter 排队 · Ctrl+S 即时注入 · Esc 中断'

export function Composer({ store, runtime }: { store: TuiStore; runtime: TuiRuntime }): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [value, setValue] = useState('')
  // 终端宽（静态帧——resize 重挂载场景由 ink 重建；与 HTML 原型 border-top 等价的无角细线）
  const cols = (process.stdout.columns ?? 80)
  const disabled = s.overlay.kind !== 'none'
  const slashOpen = value.startsWith('/')
  const slashMatches = slashOpen ? filterCommands(value) : []
  const [slashSel, setSlashSel] = useState(0)

  useInput((input, key) => {
    if (disabled) return // 浮层态输入归 Overlays
    if (key.ctrl && (input === 's' || input === 'S')) {
      if (value.trim()) { runtime.steer(value); setValue('') }
      return
    }
    if (key.ctrl && (input === 't' || input === 'T')) { runtime.toggleToolDetail(); return }
    if (key.return) {
      if (slashOpen && slashMatches.length) {
        setValue(slashMatches[slashSel % slashMatches.length]!.cmd)
        return
      }
      if (value.trim()) { runtime.submit(value); setValue(''); setSlashSel(0) }
      return
    }
    if (key.upArrow && slashOpen && slashMatches.length) { setSlashSel(sel => (sel + slashMatches.length - 1) % slashMatches.length); return }
    if (key.downArrow && slashOpen && slashMatches.length) { setSlashSel(sel => (sel + 1) % slashMatches.length); return }
    if (key.tab && slashOpen && slashMatches.length) { setValue(slashMatches[slashSel % slashMatches.length]!.cmd); return }
    if (key.backspace || key.delete) { setValue(v => v.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.escape) return
    if (input) setValue(v => v + input)
  })

  const symColor = s.running ? DEEP_SPACE.violet : DEEP_SPACE.accent
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="#2a3050">{'─'.repeat(Math.max(0, cols - 1))}</Text>
      {s.queue.length > 0 ? (
        <Box paddingLeft={1}>
          <Text color={DEEP_SPACE.warn}>⌛ 已排队 {s.queue.length} 条（运行结束自动发 · Esc 中断不丢）</Text>
        </Box>
      ) : null}
      {slashOpen && slashMatches.length > 0 ? (
        <Box flexDirection="column" paddingLeft={1} paddingBottom={0}>
          {slashMatches.slice(0, 8).map((m, i) => (
            <Text key={m.cmd} color={i === slashSel % slashMatches.length ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
              {i === slashSel % slashMatches.length ? '▸ ' : '  '}{m.cmd.padEnd(14)} {m.desc}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box paddingLeft={1}>
        <Text>
          <Text color={symColor} bold>❯ </Text>
          {value ? <Text>{value}</Text> : <Text color={DEEP_SPACE.dim}>{s.running ? PLACEHOLDER_BUSY : DEEP_SPACE.placeholders[s.placeholderIdx]!}</Text>}
          <Text color={symColor}>▏</Text>
        </Text>
      </Box>
      <Box paddingLeft={1} gap={2}>
        <Text color={DEEP_SPACE.dim}>
          {s.running
            ? 'Enter 排队 · Ctrl+S 注入 · Esc 中断'
            : 'Enter 发送 · / 命令 · Ctrl+T 工具详情 · Ctrl+C 退出'}
        </Text>
      </Box>
    </Box>
  )
}

/** 高频命令目录（完整 63 条走 /help——命令面映射：高频进菜单，长尾进帮助） */
export const QUICK_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/help', desc: '命令手册（63 命令）' },
  { cmd: '/model', desc: '模型目录与密钥' },
  { cmd: '/build', desc: '需求编译全流程' },
  { cmd: '/doctor', desc: '全组件自检' },
  { cmd: '/memory', desc: '三层记忆管理' },
  { cmd: '/hole', desc: '记忆语义检索' },
  { cmd: '/perm', desc: '权限规则' },
  { cmd: '/sessions', desc: '会话列表/恢复' },
  { cmd: '/usage', desc: '用量与成本' },
  { cmd: '/context', desc: '上下文水位' },
  { cmd: '/offline', desc: '离线生存模式' },
  { cmd: '/theme', desc: '主题切换' },
  { cmd: '/undo', desc: '撤销上一回合' },
  { cmd: '/new', desc: '新会话' },
  { cmd: '/compact', desc: '上下文压缩' },
  { cmd: '/perm rule list', desc: '规则清单' },
]

export function filterCommands(input: string): Array<{ cmd: string; desc: string }> {
  const q = input.slice(1).toLowerCase()
  return QUICK_COMMANDS.filter(c => c.cmd.toLowerCase().includes(q) || c.desc.includes(q)).slice(0, 8)
}
