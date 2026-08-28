import { coreCommands } from './slash/chat.js'
import { debugCommands } from './slash/diagnostics.js'
import { opsCommands } from './slash/ops.js'
import { sessionCommands } from './slash/conversation.js'
import { setupCommands } from './slash/bootstrap.js'
import type { SlashCommand } from './slashTypes.js'

// wxnodus 适配：保留 本地 UI 命令（config.set/session.* 等已由 wxGateway 桥接），
// 移除调用未实现 RPC 的命令——同名 wxnodus 中文命令会经 slash.exec RPC 接管
// 审计修复：此前 21 个命令（voice/skills/agents/replay 等）因后端 RPC 占位被移除，
// 导致「未知命令」+ skillsHub/agentsOverlay 不可达——对应 RPC 已全部真实实现，逐一加回
const KEEP_LOCAL = new Set<string>([
  // core.ts：本地 UI 操作
  'quit', 'mouse', 'clear', 'redraw', 'details', 'fortune', 'copy', 'paste',
  'terminal-setup', 'history', 'statusbar', 'queue', 'undo', 'title', 'update', 'save',
  'retry', 'steer', 'heapdump', 'mem', 'stop',
  // session.ts：config.set / session.active_list 已桥接
  'model', 'sessions', 'skin', 'indicator', 'reasoning', 'fast', 'busy', 'verbose',
  'personality', 'compress', 'branch', 'background',
  // setup.ts：setup.status/config.set 已桥接
  'setup',
  // ops.ts：P1c 插件面板（无参开面板；子命令走 slash.exec 内核）
  'plugins',
  // ops.ts：面板/回放/技能/工具（对应 RPC 已真实实现——spawn_tree.*/skills.manage/
  // skills.reload/reload.mcp/session.*）
  'agents', 'replay', 'replay-diff', 'skills', 'tools', 'reload', 'reload-mcp', 'reload-skills',
  'rollback',
  // conversation.ts：语音/图像（voice.*/image.attach 已真实实现）
  'voice', 'image',
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
