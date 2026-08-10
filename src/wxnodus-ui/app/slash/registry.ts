import { coreCommands } from './commands/core.js'
import { debugCommands } from './commands/debug.js'
import { opsCommands } from './commands/ops.js'
import { sessionCommands } from './commands/session.js'
import { setupCommands } from './commands/setup.js'
import type { SlashCommand } from './types.js'

// wxnodus 适配：保留 本地 UI 命令（config.set/session.* 等已由 wxGateway 桥接），
// 移除调用未实现 RPC 的命令——同名 wxnodus 中文命令会经 slash.exec RPC 接管
const KEEP_LOCAL = new Set<string>([
  // core.ts：本地 UI 操作
  'quit', 'mouse', 'clear', 'redraw', 'details', 'fortune', 'copy', 'paste',
  'terminal-setup', 'history', 'statusbar', 'queue', 'undo', 'title',
  // session.ts：config.set / session.active_list 已桥接
  'model', 'sessions', 'skin', 'indicator', 'reasoning', 'fast', 'busy', 'verbose',
  // setup.ts：setup.status/config.set 已桥接
  'setup',
  // ops.ts：P1c 插件面板（无参开面板；子命令走 slash.exec 内核）
  'plugins'
])

export const SLASH_COMMANDS: SlashCommand[] = [
  ...coreCommands,
  ...sessionCommands,
  ...opsCommands,
  ...setupCommands,
  ...debugCommands
].filter(cmd => KEEP_LOCAL.has(cmd.name))

const byName = new Map<string, SlashCommand>(
  SLASH_COMMANDS.flatMap(cmd => [cmd.name, ...(cmd.aliases ?? [])].map(name => [name, cmd] as const))
)

export const findSlashCommand = (name: string) => byName.get(name.toLowerCase())
