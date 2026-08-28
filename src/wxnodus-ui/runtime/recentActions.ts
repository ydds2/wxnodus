// src/wxnodus-ui/runtime/recentActions.ts — 最近动作（命令面板「最近」区数据源，P2 增强 2026-08-20）
// 模块级内存（与 vimMode/keymap last-good 同模式）：记录用户提交的斜杠命令与命令面板执行动作，
// 上限 8、最近在前、重复去重（重新执行提到最前）。只记录动作文本，不记录普通对话消息。
let ACTIONS: string[] = []

export const RECENT_ACTIONS_MAX = 8

/** 记录一条动作（空文本忽略；重复动作去重并提到最前；超上限截尾） */
export function recordRecentAction(text: string): void {
  const t = text.trim()
  if (!t) return
  ACTIONS = [t, ...ACTIONS.filter(a => a !== t)].slice(0, RECENT_ACTIONS_MAX)
}

/** 最近动作（最近在前） */
export function getRecentActions(): string[] {
  return ACTIONS
}

/** 清空（会话/测试重置用） */
export function clearRecentActions(): void {
  ACTIONS = []
}
