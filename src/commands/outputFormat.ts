// src/commands/outputFormat.ts — ⅩⅩⅩⅣ 代码规范化：命令输出格式单一事实源
// 此前 `const lines = (title, body)` 在 7 个文件中有 7 份拷贝（2 个家族——朴素版与框线版）。
// 本模块统一为 docs/output-format-spec-2026.md 规范的「标题行 + 两格缩进条目（纯文本、无边框）」。
// 框线版（带宽度计算的 legacy 家族）保留兼容导出——渐进迁移，不破坏既有输出。

/** 输出格式规范版：标题行 + 两格缩进条目（纯文本无边框——output-format-spec 契约） */
export const lines = (title: string, body: string[]): string =>
  [title, ...body.map(l => `  ${l}`)].join('\n')

/** 单条目（无标题——一行纯文本） */
export const line = (text: string): string => `  ${text}`

/** 框线版（legacy 家族——ext/sessionCommands 等仍在用；迁移完成后删除） */
export const linesBoxed = (title: string, body: string[], width = 80): string => {
  const w = Math.min(width, 80)
  const bar = '─'.repeat(Math.max(0, w - 1))
  return [title, bar, ...body.map(l => `  ${l}`)].join('\n')
}
