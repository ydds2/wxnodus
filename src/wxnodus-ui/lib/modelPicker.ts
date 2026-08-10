// src/wxnodus-ui/lib/modelPicker.ts — 模型选择器纯逻辑（provider 分组 + 键盘导航）
// 自研：零渲染依赖，可单测；UI 组件层消费这些纯函数
import { MODEL_CATALOG, filterModels } from '../../kernel/providers.js';
import type { ModelEntry } from '../../kernel/providers.js';

export interface PickerState { q: string; sel: number }

export function initPicker(): PickerState { return { q: '', sel: 0 }; }

export type PickerAction = { type: 'pick' | 'cancel' | 'toggleThinking' | 'none' };

export interface PickerKey {
  input?: string; return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean;
  leftArrow?: boolean; rightArrow?: boolean; backspace?: boolean; ctrl?: boolean; inputChar?: string;
}

// 纯函数：输入键 → 新状态 + 动作（选择/取消/切换 thinking/移动/过滤）
export function handlePickerKey(s: PickerState, key: PickerKey, listLen: number): { next: PickerState; action: PickerAction } {
  if (key.return) return { next: s, action: { type: 'pick' } };
  if (key.escape) return { next: s, action: { type: 'cancel' } };
  if (key.leftArrow || key.rightArrow) return { next: s, action: { type: 'toggleThinking' } };
  if (key.upArrow) return { next: { ...s, sel: Math.max(0, s.sel - 1) }, action: { type: 'none' } };
  if (key.downArrow) return { next: { ...s, sel: Math.min(Math.max(listLen - 1, 0), s.sel + 1) }, action: { type: 'none' } };
  if (key.backspace) return { next: { ...s, q: s.q.slice(0, -1), sel: 0 }, action: { type: 'none' } };
  const ch = key.inputChar ?? key.input ?? '';
  if (ch && !key.ctrl) return { next: { ...s, q: s.q + ch, sel: 0 }, action: { type: 'none' } };
  return { next: s, action: { type: 'none' } };
}

// 按 provider 分组（保持目录顺序）
export function groupByProvider(list: ModelEntry[]): Array<{ provider: string; models: ModelEntry[] }> {
  const out: Array<{ provider: string; models: ModelEntry[] }> = [];
  for (const m of list) {
    const g = out.find(x => x.provider === m.provider);
    if (g) g.models.push(m);
    else out.push({ provider: m.provider, models: [m] });
  }
  return out;
}

// 目录过滤 + 当前模型标记（供 UI 消费）
export function pickerList(q: string): ModelEntry[] {
  return filterModels(q.trim(), MODEL_CATALOG);
}
