// src/ui/lib/composerKeys.ts — L6-2 Composer 键位处理（纯函数，可单测）
// 设计：Enter 提交 / Shift+Enter·Ctrl+J 换行 / ↑↓ 历史；返回新状态与动作
export interface ComposerState { value: string; history: string[]; hIndex: number }

export interface KeyEvent { return?: boolean; shift?: boolean; ctrl?: boolean; upArrow?: boolean; downArrow?: boolean; input?: string }

export type ComposerAction =
  | { type: 'submit'; text: string }
  | { type: 'setValue'; value: string }
  | { type: 'newline' }
  | { type: 'none' };

export function initComposer(initialHistory: string[] = []): ComposerState {
  return { value: '', history: [...initialHistory].slice(-1000), hIndex: -1 };
}

// 处理按键 → 新状态 + 动作（纯逻辑，React 层只需 setState 与 onSubmit）
export function handleComposerKey(s: ComposerState, key: KeyEvent): { next: ComposerState; action: ComposerAction } {
  // Enter（无修饰键）→ 提交
  if (key.return && !key.shift && !key.ctrl) {
    const v = s.value.trim();
    if (!v) return { next: { ...s, hIndex: -1 }, action: { type: 'none' } };
    const history = [v, ...s.history.filter(h => h !== v)].slice(0, 1000);
    return { next: { value: '', history, hIndex: -1 }, action: { type: 'submit', text: v } };
  }
  // Shift+Enter / Ctrl+Enter → 换行
  if (key.return && (key.shift || key.ctrl)) {
    return { next: { ...s, value: s.value + '\n' }, action: { type: 'newline' } };
  }
  // ↑ 历史（单行时）
  if (key.upArrow && !s.value.includes('\n')) {
    const hIndex = s.hIndex < 0 ? 0 : Math.min(s.hIndex + 1, s.history.length - 1);
    const value = s.history[hIndex] ?? s.value;
    return { next: { ...s, value, hIndex }, action: { type: 'setValue', value } };
  }
  // ↓ 历史回退
  if (key.downArrow && !s.value.includes('\n')) {
    if (s.hIndex <= 0) return { next: { ...s, value: '', hIndex: -1 }, action: { type: 'setValue', value: '' } };
    const hIndex = s.hIndex - 1;
    const value = s.history[hIndex] ?? '';
    return { next: { ...s, value, hIndex }, action: { type: 'setValue', value } };
  }
  return { next: s, action: { type: 'none' } };
}
