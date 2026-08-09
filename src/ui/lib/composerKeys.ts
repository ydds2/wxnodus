// src/ui/lib/composerKeys.ts — Composer 键位处理（纯函数，可单测，零测量循环）
// 设计（参考 Kimi/Codex 输入框行为，自有实现）：
//   Enter 提交 / Shift+Enter·Ctrl+J 换行 / ↑↓ 历史 / ←→ 移动 / Backspace·Delete 删除
// 全部为纯逻辑，React 层只做 setState 与 onSubmit——不依赖任何第三方输入组件，
// 从根上避免 useBoxMetrics/measureElement 测量循环导致的渲染抖动与输入丢失。
export interface ComposerState { value: string; cursor: number; history: string[]; hIndex: number }

export interface KeyEvent {
  input?: string;
  return?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean;
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean;
  backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean;
}

export type ComposerAction =
  | { type: 'submit'; text: string }
  | { type: 'setValue'; value: string; cursor: number }
  | { type: 'newline' }
  | { type: 'none' };

const NONE: ComposerAction = { type: 'none' };

export function initComposer(initialHistory: string[] = []): ComposerState {
  return { value: '', cursor: 0, history: [...initialHistory].slice(-1000), hIndex: -1 };
}

function insert(s: ComposerState, text: string): { next: ComposerState; action: ComposerAction } {
  const value = s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor);
  return { next: { ...s, value, cursor: s.cursor + text.length, hIndex: -1 }, action: { type: 'setValue', value, cursor: s.cursor + text.length } };
}

function move(s: ComposerState, delta: number): { next: ComposerState; action: ComposerAction } {
  const cursor = Math.max(0, Math.min(s.value.length, s.cursor + delta));
  if (cursor === s.cursor) return { next: s, action: NONE };
  return { next: { ...s, cursor }, action: { type: 'setValue', value: s.value, cursor } };
}

function del(s: ComposerState, dir: 1 | -1): { next: ComposerState; action: ComposerAction } {
  if (dir === -1) {
    if (s.cursor <= 0) return { next: s, action: NONE };
    const value = s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor);
    return { next: { ...s, value, cursor: s.cursor - 1, hIndex: -1 }, action: { type: 'setValue', value, cursor: s.cursor - 1 } };
  }
  if (s.cursor >= s.value.length) return { next: s, action: NONE };
  const value = s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1);
  return { next: { ...s, value, hIndex: -1 }, action: { type: 'setValue', value, cursor: s.cursor } };
}

// 处理按键 → 新状态 + 动作（纯逻辑，React 层只需 setState 与 onSubmit）
export function handleComposerKey(s: ComposerState, key: KeyEvent): { next: ComposerState; action: ComposerAction } {
  // Enter（无修饰键）→ 提交
  if (key.return && !key.shift && !key.ctrl) {
    const v = s.value.trim();
    if (!v) return { next: { ...s, hIndex: -1 }, action: NONE };
    const history = [v, ...s.history.filter(h => h !== v)].slice(0, 1000);
    return { next: { value: '', cursor: 0, history, hIndex: -1 }, action: { type: 'submit', text: v } };
  }
  // Shift+Enter / Ctrl+Enter → 光标处换行
  if (key.return && (key.shift || key.ctrl)) {
    const r = insert(s, '\n');
    return { next: r.next, action: { type: 'newline' } };
  }
  // ← → 光标移动
  if (key.leftArrow && !key.ctrl) return move(s, -1);
  if (key.rightArrow && !key.ctrl) return move(s, 1);
  if (key.home) return move(s, -s.cursor);
  if (key.end) return move(s, s.value.length - s.cursor);
  // Backspace / Delete
  if (key.backspace) return del(s, -1);
  if (key.delete) return del(s, 1);
  // ↑ ↓ 历史（仅单行时）
  if (key.upArrow && !s.value.includes('\n')) {
    const hIndex = s.hIndex < 0 ? 0 : Math.min(s.hIndex + 1, s.history.length - 1);
    const value = s.history[hIndex] ?? s.value;
    return { next: { ...s, value, cursor: value.length, hIndex }, action: { type: 'setValue', value, cursor: value.length } };
  }
  if (key.downArrow && !s.value.includes('\n')) {
    if (s.hIndex <= 0) return { next: { ...s, value: '', cursor: 0, hIndex: -1 }, action: { type: 'setValue', value: '', cursor: 0 } };
    const hIndex = s.hIndex - 1;
    const value = s.history[hIndex] ?? '';
    return { next: { ...s, value, cursor: value.length, hIndex }, action: { type: 'setValue', value, cursor: value.length } };
  }
  // 普通字符输入 / 粘贴文本整体插入（排除控制组合键；ink 粘贴时多字符一次性到达）
  if (key.input && !key.ctrl && !key.meta && !key.shift) {
    const printable = [...key.input].every(c => c.charCodeAt(0) >= 32 || c === '\n');
    if (printable) return insert(s, key.input);
  }
  return { next: s, action: NONE };
}
