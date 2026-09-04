// src/tui/theme.ts — 主题系统（原型 31「主题实时预览」的实现侧）：四主题色板 + DEEP_SPACE 代理
// 组件零改动：DEEP_SPACE 保持既有 import 面，取值经 Proxy 动态走当前主题（改即存——面板选择即时生效）。
// 机制参考：gemini ThemeDialog.tsx:341 模式（左列表右 ColorsDisplay，所见即所得）；实现原创。
// 颜色全部命名色档（cmd 传统 conhost 可渲染——原型场景 55 可实现性对照）；单色档供打印/管道友好。

export interface TuiThemeTokens {
  accent: string
  violet: string
  success: string
  warn: string
  error: string
  fg: string
  muted: string
  dim: string
  /** 三明治边界细线（上下沿） */
  line: string
  spinnerFrames: readonly string[]
  placeholders: readonly string[]
}

/** 四主题（原型 31：深空默认 / 晨昏暖色低蓝 / 高对比无障碍 / 纯单色打印友好） */
export const TUI_THEMES: Record<string, { label: string; desc: string; tokens: TuiThemeTokens }> = {
  deepspace: {
    label: '深空（默认）',
    desc: '冷色深空 · 蓝紫绿警示四色系',
    tokens: {
      accent: 'cyanBright', violet: 'magentaBright', success: 'greenBright',
      warn: 'yellow', error: 'red', fg: 'white', muted: 'gray', dim: 'gray',
      line: '#2a3050',
      spinnerFrames: ['◐', '◓', '◑', '◒'],
      placeholders: [
        '有问题尽管问，或直接派活',
        '描述任务，或 /build 直接编译需求',
        '试试 @src/ 引用文件',
        'Ready for instructions…',
        '/doctor 先自检一下？',
        'Tab 补全命令 · /perm 切换模式',
        '/keys 键位速查 · Ctrl+↑↓ 翻历史',
      ],
    },
  },
  dusk: {
    label: '晨昏',
    desc: '暖色低蓝光 · 夜间护眼',
    tokens: {
      accent: 'yellowBright', violet: 'magenta', success: 'green',
      warn: 'yellow', error: 'red', fg: 'white', muted: 'gray', dim: 'gray',
      line: '#4a3f2f',
      spinnerFrames: ['◐', '◓', '◑', '◒'],
      placeholders: ['晚上好，说说要做什么', '描述任务，或 /build 直接编译需求', '试试 @src/ 引用文件', 'Ready for instructions…', '/doctor 先自检一下？', 'Tab 补全命令 · /perm 切换模式', '/keys 键位速查 · Ctrl+↑↓ 翻历史'],
    },
  },
  contrast: {
    label: '高对比',
    desc: '无障碍 · WCAG AA 语义色',
    tokens: {
      accent: 'cyanBright', violet: 'magentaBright', success: 'greenBright',
      warn: 'yellowBright', error: 'redBright', fg: 'whiteBright', muted: 'white', dim: 'gray',
      line: '#5a6270',
      spinnerFrames: ['◐', '◓', '◑', '◒'],
      placeholders: ['有问题尽管问，或直接派活', '描述任务，或 /build 直接编译需求', '试试 @src/ 引用文件', 'Ready for instructions…', '/doctor 先自检一下？', 'Tab 补全命令 · /perm 切换模式', '/keys 键位速查 · Ctrl+↑↓ 翻历史'],
    },
  },
  mono: {
    label: '纯单色',
    desc: '打印/管道友好 · 语义靠字形',
    tokens: {
      accent: 'white', violet: 'white', success: 'white',
      warn: 'white', error: 'white', fg: 'white', muted: 'gray', dim: 'gray',
      line: '#808080',
      spinnerFrames: ['-', '\\', '|', '/'],
      placeholders: ['有问题尽管问，或直接派活', '描述任务，或 /build 直接编译需求', '试试 @src/ 引用文件', 'Ready for instructions…', '/doctor 先自检一下？', 'Tab 补全命令 · /perm 切换模式', '/keys 键位速查 · Ctrl+↑↓ 翻历史'],
    },
  },
}

export const TUI_THEME_NAMES = Object.keys(TUI_THEMES) as string[]

let current = 'deepspace'

/** 切换当前主题（未知名回退默认——零崩溃）；返回实际生效名 */
export function setTuiTheme(name: string): string {
  current = TUI_THEMES[name] ? name : 'deepspace'
  return current
}

export function tuiThemeName(): string { return current }

/** 取指定主题色板（主题选择器预览用——不经全局代理） */
export function paletteOf(name: string): TuiThemeTokens {
  return (TUI_THEMES[name] ?? TUI_THEMES.deepspace)!.tokens
}

/**
 * DEEP_SPACE 全局代理：既有 import 面不变，取值动态走当前主题——
 * 主题切换即刻生效，无需组件改造（改即存：设置持久化与面板选择同链路）。
 */
export const DEEP_SPACE = new Proxy({} as TuiThemeTokens, {
  get: (_t, k: keyof TuiThemeTokens) => paletteOf(current)[k],
})
