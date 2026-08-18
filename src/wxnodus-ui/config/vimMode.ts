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
