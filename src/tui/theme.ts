// src/tui/theme.ts — 深空主题 token（原型 docs/ui-prototype 定稿 · as const 字面量
// 自动匹配 @wxnodus/ink Color 联合——不依赖包类型导出）。
// 全自研 TUI（2026-08-29 用户裁决）：机制参考 kimi/crush/codex（AGENTS.md 参考不抄袭）。
// 颜色为命名色档（cmd 传统 conhost 可渲染——原型场景 55 可实现性对照）。

export const DEEP_SPACE = {
  accent: 'ansi:cyanBright',
  violet: 'ansi:magentaBright',
  success: 'ansi:greenBright',
  warn: 'ansi:yellow',
  error: 'ansi:red',
  fg: 'ansi:white',
  muted: '#8b93ad',
  dim: '#8b93ad',
  spinnerFrames: ['◐', '◓', '◑', '◒'],
  placeholders: [
    '有问题尽管问，或直接派活 (Ready!)',
    '描述任务，或 /build 直接编译需求',
    '试试 @src/ 引用文件',
    'Ready for instructions…',
    '/doctor 先自检一下？',
  ],
  tips: [
    'Shift+Tab 计划模式（规划中）· Ctrl+X 循环模式',
    'Esc 中断回合 · Ctrl+T 展开工具详情',
    'Enter 排队 · Ctrl+S steer 即时注入',
    '/help 查看全部命令 · /doctor 自检',
    '/offline on 离线生存 · /model 切模型',
  ],
} as const

export type TuiTheme = typeof DEEP_SPACE
