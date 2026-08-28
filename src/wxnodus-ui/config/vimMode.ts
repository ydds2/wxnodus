// src/wxnodus-ui/config/vimMode.ts — 波 3 ②：vim 模态开关水合（keymap 同款模块级 last-good 模式）
// /vim 命令 → settings.vimMode 落盘 → useConfigWatcher 轮询水合 setVimModeEnabled →
// textInput 消费 getVimModeEnabled；cfg 为 null 保持上次有效值（last-good 守卫）。
let VIM_MODE_ENABLED = false

export function setVimModeEnabled(enabled: boolean): void {
  VIM_MODE_ENABLED = enabled
}

export function getVimModeEnabled(): boolean {
  return VIM_MODE_ENABLED
}


// ── vim NORMAL 激活标志（P1 裁决 2026-08-20）：textInput 在模态变化时同步；
// useKeyBindings 消费——Ctrl+R 历史搜索在 vim NORMAL 下让位 vim redo（双触发裁决，
// keymap registry diagnoseKeymap 实测证据：global.history × vim.redo）。
let VIM_NORMAL_ACTIVE = false

/** vim 模态变化时由 textInput 同步（mode !== 'insert' 即 NORMAL/VISUAL 激活） */
export function setVimNormalActive(active: boolean): void {
  VIM_NORMAL_ACTIVE = active
}

export function getVimNormalActive(): boolean {
  return VIM_NORMAL_ACTIVE
}

/**
 * P4-5（A-23）：insert 光标域（0..len）→ normal 域（0..len-1）转换——离开 insert 时
 * 左移一格坐在字符上（真 vim 语义；不转换则 x/dw 等作用对象越界为 no-op，接线实测）。
 * 抽在 vimMode（textInput 与测试共用；textInput 有 L4 行数 ratchet 只降不升）。
 */
export function insertToNormalCursor(textLength: number, cursor: number): number {
  return textLength ? Math.max(0, Math.min(cursor, textLength) - 1) : 0;
}
