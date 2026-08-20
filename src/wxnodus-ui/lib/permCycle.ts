// src/wxnodus-ui/lib/permCycle.ts — Shift+Tab 模式循环（claude-code parity 增强）
// 循环序：smart → auto → manual → plan → yolo → goal → smart（风险递增，兜回最保守）
export const PERM_MODES = ['smart', 'auto', 'manual', 'plan', 'yolo', 'goal'] as const;
export type PermMode = (typeof PERM_MODES)[number];

export function nextPermMode(current: string | null | undefined): PermMode {
  const i = (PERM_MODES as readonly string[]).indexOf(current ?? '');
  return PERM_MODES[(i + 1) % PERM_MODES.length]!;
}
