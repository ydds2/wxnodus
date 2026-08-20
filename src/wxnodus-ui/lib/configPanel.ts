// src/wxnodus-ui/lib/configPanel.ts — 配置面板纯逻辑（零渲染依赖，可单测）
// 行模型/键盘导航/布尔切换值——组件层只消费这些纯函数（modelPicker 同款分层）

export interface ConfigPanelState { sel: number }

export const initConfigPanel = (): ConfigPanelState => ({ sel: 0 });

export interface ConfigPanelKey {
  upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean;
}

export type ConfigPanelAction = 'toggle' | 'edit' | 'cancel' | 'none';

export function handleConfigPanelKey(s: ConfigPanelState, key: ConfigPanelKey, len: number): { next: ConfigPanelState; action: ConfigPanelAction } {
  if (key.escape) return { next: s, action: 'cancel' };
  if (key.return) return { next: s, action: 'edit' };
  if (key.upArrow) return { next: { ...s, sel: Math.max(0, s.sel - 1) }, action: 'none' };
  if (key.downArrow) return { next: { ...s, sel: Math.min(Math.max(len - 1, 0), s.sel + 1) }, action: 'none' };
  return { next: s, action: 'none' };
}

export interface ConfigRow { key: string; value: string; known: boolean; boolean: boolean }

/** 行模型：排序 + 已知标记（白名单）+ 布尔标记（面板 Enter 即切换） */
export function configRows(settings: Record<string, unknown>, known: string[]): ConfigRow[] {
  return Object.keys(settings).sort().map(k => ({
    key: k,
    value: JSON.stringify(settings[k]),
    known: known.includes(k),
    boolean: typeof settings[k] === 'boolean',
  }));
}

/** 布尔切换下一值（true → false → true 循环） */
export function toggleBoolean(current: unknown): boolean {
  return current !== true;
}
