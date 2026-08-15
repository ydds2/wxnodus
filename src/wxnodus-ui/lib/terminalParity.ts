import {
  detectVSCodeLikeTerminal,
  type FileOps,
  isRemoteShellSession,
  shouldPromptForTerminalSetup
} from './terminalSetup.js'
import { getTuiTerminalTier } from './terminalTier.js'

export type MacTerminalHint = {
  key: string
  message: string
  tone: 'info' | 'warn'
}

export type MacTerminalContext = {
  isAppleTerminal: boolean
  isRemote: boolean
  isTmux: boolean
  vscodeLike: null | 'cursor' | 'vscode' | 'windsurf'
}

export function detectMacTerminalContext(env: NodeJS.ProcessEnv = process.env): MacTerminalContext {
  const termProgram = env['TERM_PROGRAM'] ?? ''

  return {
    isAppleTerminal: termProgram === 'Apple_Terminal' || !!env['TERM_SESSION_ID'],
    isRemote: isRemoteShellSession(env),
    isTmux: !!env['TMUX'],
    vscodeLike: detectVSCodeLikeTerminal(env)
  }
}

export async function terminalParityHints(
  env: NodeJS.ProcessEnv = process.env,
  options?: { fileOps?: Partial<FileOps>; homeDir?: string }
): Promise<MacTerminalHint[]> {
  const ctx = detectMacTerminalContext(env)
  const hints: MacTerminalHint[] = []

  if (
    ctx.vscodeLike &&
    (await shouldPromptForTerminalSetup({ env, fileOps: options?.fileOps, homeDir: options?.homeDir }))
  ) {
    hints.push({
      key: 'ide-setup',
      tone: 'info',
      message: `Detected ${ctx.vscodeLike} terminal · run /terminal-setup for best Cmd+Enter / undo parity`
    })
  }

  if (ctx.isAppleTerminal) {
    hints.push({
      key: 'apple-terminal',
      tone: 'warn',
      message:
        'Apple Terminal detected · use /paste for image-only clipboard fallback, and try Ctrl+A / Ctrl+E / Ctrl+U if Cmd+←/→/⌫ gets rewritten'
    })
  }

  if (ctx.isTmux) {
    hints.push({
      key: 'tmux',
      tone: 'warn',
      message:
        'tmux detected · clipboard copy/paste uses passthrough when available; allow-passthrough improves OSC52 reliability'
    })
  }

  if (ctx.isRemote) {
    hints.push({
      key: 'remote',
      tone: 'warn',
      message:
        'SSH session detected · text clipboard can bridge via OSC52, but image clipboard and local screenshot paths still depend on the machine running WxNodus'
    })
  }

  // W8-24：cmd（经典 conhost）档提示——VT/QuickEdit 已自动处理，剩余风险如实告知
  const tier = getTuiTerminalTier()?.tier
  if (tier === 'cmd') {
    hints.push({
      key: 'cmd-conhost',
      tone: 'info',
      message: '经典 cmd 控制台 · 已自动开启 VT 并关闭快速编辑；颜色收敛 256 色、图形为 BMP 安全集——如需 emoji 全量显示，建议 Windows Terminal'
    })
  }

  return hints
}
