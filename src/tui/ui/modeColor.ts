// src/tui/ui/modeColor.ts — 模式档位着色（原型 06/46：plan 紫 · yolo/afk 危险档橙 · 其余档强调蓝）
export function modeColor(mode: string): string {
  if (mode === 'plan' || mode === 'goal') return 'magentaBright'
  if (mode === 'yolo' || mode === 'afk') return 'yellow'
  return 'cyanBright'
}
