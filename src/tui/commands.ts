// src/tui/commands.ts — 高频命令目录（组件无关——painter/engine 共用；长尾走 /help）
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
  { cmd: '/status', desc: '运行状态' },
]

export function filterCommands(input: string): Array<{ cmd: string; desc: string }> {
  const q = input.startsWith('/') ? input.slice(1).toLowerCase() : input.toLowerCase()
  return QUICK_COMMANDS.filter(c => c.cmd.toLowerCase().includes(q) || c.desc.includes(q)).slice(0, 8)
}
