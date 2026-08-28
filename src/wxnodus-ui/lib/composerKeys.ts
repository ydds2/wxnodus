// src/ui/lib/composerKeys.ts — Composer 键位处理（纯函数，可单测，零测量循环）
// 设计（参考 Kimi/Codex/Claude Code 输入框行为，自有实现）：
//   Enter 提交 / Shift+Enter·Ctrl+J 换行 / ↑↓ 历史或命令建议 / ←→ 移动 /
//   Backspace·Delete 删除 / Tab 补全建议 / Esc 取消建议
// 命令建议态：value 以 / 开头时，调用方传入 suggest 列表，↑↓ 选择、
//   Enter 执行选中命令、Tab 补全、Esc 清空——输入框始终活跃，非模式切换。
// 全部为纯逻辑，React 层只做 setState 与 onSubmit——不依赖任何第三方输入组件。
export interface ComposerState { value: string; cursor: number; history: string[]; hIndex: number; suggestSel: number }

export interface KeyEvent {
  input?: string;
  return?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean; tab?: boolean; escape?: boolean;
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
  return { value: '', cursor: 0, history: [...initialHistory].slice(-1000), hIndex: -1, suggestSel: 0 };
}

function insert(s: ComposerState, text: string): { next: ComposerState; action: ComposerAction } {
  const value = s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor);
  return { next: { ...s, value, cursor: s.cursor + text.length, hIndex: -1, suggestSel: 0 }, action: { type: 'setValue', value, cursor: s.cursor + text.length } };
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
    return { next: { ...s, value, cursor: s.cursor - 1, hIndex: -1, suggestSel: 0 }, action: { type: 'setValue', value, cursor: s.cursor - 1 } };
  }
  if (s.cursor >= s.value.length) return { next: s, action: NONE };
  const value = s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1);
  return { next: { ...s, value, hIndex: -1, suggestSel: 0 }, action: { type: 'setValue', value, cursor: s.cursor } };
}

// 处理按键 → 新状态 + 动作（suggest 为当前命令建议列表，建议态时由调用方传入）
export function handleComposerKey(s: ComposerState, key: KeyEvent, suggest: string[] = []): { next: ComposerState; action: ComposerAction } {
  const suggesting = suggest.length > 0;
  const selCmd = suggesting ? suggest[Math.min(s.suggestSel, suggest.length - 1)] : undefined;

  // Enter（无修饰键）：建议态 → 执行选中命令；否则普通提交
  if (key.return && !key.shift && !key.ctrl) {
    if (suggesting && selCmd) {
      const history = [selCmd, ...s.history.filter(h => h !== selCmd)].slice(0, 1000);
      return { next: { value: '', cursor: 0, history, hIndex: -1, suggestSel: 0 }, action: { type: 'submit', text: selCmd } };
    }
    const v = s.value.trim();
    if (!v) return { next: { ...s, hIndex: -1 }, action: NONE };
    const history = [v, ...s.history.filter(h => h !== v)].slice(0, 1000);
    return { next: { value: '', cursor: 0, history, hIndex: -1, suggestSel: 0 }, action: { type: 'submit', text: v } };
  }
  // Shift+Enter / Ctrl+Enter → 光标处换行
  if (key.return && (key.shift || key.ctrl)) {
    const r = insert(s, '\n');
    return { next: r.next, action: { type: 'newline' } };
  }
  // Tab → 补全选中建议
  if (key.tab && suggesting && selCmd) {
    return { next: { ...s, value: selCmd, cursor: selCmd.length, hIndex: -1, suggestSel: 0 }, action: { type: 'setValue', value: selCmd, cursor: selCmd.length } };
  }
  // Esc → 清空输入（取消建议）
  if (key.escape) {
    if (!s.value) return { next: s, action: NONE };
    return { next: { ...s, value: '', cursor: 0, hIndex: -1, suggestSel: 0 }, action: { type: 'setValue', value: '', cursor: 0 } };
  }
  // ← → 光标移动 / Home / End
  if (key.leftArrow && !key.ctrl) return move(s, -1);
  if (key.rightArrow && !key.ctrl) return move(s, 1);
  if (key.home) return move(s, -s.cursor);
  if (key.end) return move(s, s.value.length - s.cursor);
  // Backspace / Delete
  if (key.backspace) return del(s, -1);
  if (key.delete) return del(s, 1);
  // ↑ ↓：建议态 → 选择建议；否则历史导航（仅单行时）
  if (key.upArrow) {
    if (suggesting) return { next: { ...s, suggestSel: Math.max(0, s.suggestSel - 1) }, action: NONE };
    if (s.value.includes('\n')) return { next: s, action: NONE };
    const hIndex = s.hIndex < 0 ? 0 : Math.min(s.hIndex + 1, s.history.length - 1);
    const value = s.history[hIndex] ?? s.value;
    return { next: { ...s, value, cursor: value.length, hIndex }, action: { type: 'setValue', value, cursor: value.length } };
  }
  if (key.downArrow) {
    if (suggesting) return { next: { ...s, suggestSel: Math.min(suggest.length - 1, s.suggestSel + 1) }, action: NONE };
    if (s.value.includes('\n')) return { next: s, action: NONE };
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
