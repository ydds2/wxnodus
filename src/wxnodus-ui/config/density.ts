// src/wxnodus-ui/config/density.ts — TUI 密度档（P2 增强 2026-08-20）
// settings.tuiDensity：'compact'（默认，现有观感）/ 'cozy'（消息间加行距）。
// 模块级 last-good 模式（与 vimMode 同款）：/config set tuiDensity cozy → useConfigWatcher
// 轮询水合 setTuiDensity → 渲染层热生效；非法值忽略保持上次有效值（误配绝不崩 UI）。
export type TuiDensity = 'compact' | 'cozy'

let DENSITY: TuiDensity = 'compact'

export function setTuiDensity(density: unknown): void {
  if (density === 'compact' || density === 'cozy') {
    DENSITY = density
  }
  // 非法值忽略（last-good 守卫）
}

export function getTuiDensity(): TuiDensity {
  return DENSITY
}
