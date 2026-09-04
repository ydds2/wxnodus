// src/tui/termcap.ts — 终端能力探测与字符分档（原型场景 55 可实现性对照的实现侧）
// 三档：full（Windows Terminal/Cascadia/ConEmu）· basic（传统 conhost——降级字形）· ascii（无 VT 远古）
// 判定依据：环境变量组合（确定性，不猜字体——full 默认仅当明确现代终端信号）。
export type TermTier = 'full' | 'basic' | 'ascii'

export interface Glyphs {
  /** 用户/助手左边条 */
  bar: string
  /** 输入提示符 */
  prompt: string
  /** 光标 */
  caret: string
  /** 菜单/选项选中指针 */
  pointer: string
  /** 运行 spinner 帧 */
  spinner: readonly string[]
  /** 折叠指针 */
  fold: string
  /** 运行中标记（工具行） */
  running: string
  /** 排队标记 */
  queued: string
  /** 分隔点 */
  bullet: string
  /** 软连字符（密钥掩码等） */
  mask: string
  /** 输入框四边框（用户裁决：输入框四周围起来——kimi 同款；ascii 档纯 +-| 保底） */
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string }
}

const FULL: Glyphs = {
  bar: '▎', prompt: '❯', caret: '▏', pointer: '▸',
  spinner: ['◐', '◓', '◑', '◒'],
  fold: '▸', running: '◐', queued: '◷', bullet: '·', mask: '•',
  // 2026-09-03 美化：full 档圆角盒（与浮层 ink borderStyle="round" 视觉统一——现代终端安全字形）
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
}

const BASIC: Glyphs = {
  // 传统 conhost（新宋体/Consolas 档）：▎❯▏◐◷ 为豆腐高危——降级为保守集
  // 盒线族与既有三明治边界同源（'─'/'│' 已在 basic 档安全使用）——保留真实盒角
  bar: '│', prompt: '»', caret: '_', pointer: '>',
  spinner: ['-', '\\', '|', '/'],
  fold: '>', running: '*', queued: '[等]', bullet: '-', mask: '*',
  box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
}

const ASCII: Glyphs = {
  bar: '|', prompt: '>', caret: '_', pointer: '>',
  spinner: ['-', '\\', '|', '/'],
  fold: '>', running: '*', queued: '[Q]', bullet: '-', mask: '*',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
}

/** 探测终端档位（启动一次缓存——resize 不变档） */
export function detectTermTier(env: NodeJS.ProcessEnv = process.env): TermTier {
  // 强制覆盖最高优先（用户显式裁决压过一切探测）
  if (env.WXNODUS_TUI_TERM === 'full' || env.WXNODUS_TUI_TERM === 'basic' || env.WXNODUS_TUI_TERM === 'ascii') {
    return env.WXNODUS_TUI_TERM as TermTier
  }
  // 现代终端信号：Windows Terminal / ConEmu / 常见 GUI 终端 / ANSI enabled / CI xterm
  if (env.WT_SESSION) return 'full'
  if (env.ConEmuANSI === 'ON' || env.ConEmuANSI === '1') return 'full'
  // C2（2026-08-30）兼容性扩展：WezTerm/Ghostty 自有环境变量 + 现代终端 TERM_PROGRAM 家族
  if (env.WEZTERM_EXECUTABLE || env.GHOSTTY_RESOURCES_DIR) return 'full'
  if (env.TERM_PROGRAM && ['vscode', 'cursor', 'windows-terminal', 'ghostty', 'wezterm', 'tabby', 'hyper', 'alacritty'].includes(env.TERM_PROGRAM)) return 'full'
  // TERM 前缀族（xterm* / alacritty / wezterm / ghostty / kitty——mintty 的 xterm-256color 亦覆盖）
  if (env.TERM && /^(xterm|alacritty|wezterm|ghostty|kitty)/.test(env.TERM)) return 'full'
  // 24 位色声明（COLORTERM）——真彩终端必带 VT 支持
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'full'
  // 默认保守：cmd/conhost 无信号 → basic（用户可 WXNODUS_TUI_TERM=full 提升）
  return 'basic'
}

export function glyphsFor(tier: TermTier): Glyphs {
  return tier === 'full' ? FULL : tier === 'basic' ? BASIC : ASCII
}

/** 全局单例（App 启动时装载——组件零探测成本） */
let current: { tier: TermTier; g: Glyphs } = { tier: 'basic', g: BASIC }

export function initTermcap(env: NodeJS.ProcessEnv = process.env): TermTier {
  const tier = detectTermTier(env)
  current = { tier, g: glyphsFor(tier) }
  return tier
}

export function glyphs(): Glyphs { return current.g }
export function tier(): TermTier { return current.tier }
