// src/ui/lib/vimKeys.ts — L6-3 差距 #1：vim 模式薄层（NORMAL/INSERT + 核心键位）
export interface VimMode {
  mode: 'normal' | 'insert' | 'visual';
  value: string;
  cursor?: number;
  pending?: string;
}

export function vimHandleKey(key: string, s: VimMode): VimMode {
  if (s.mode === 'insert') {
    if (key === 'escape') return { ...s, mode: 'normal' };
    if (key.length === 1) {
      const c = s.cursor ?? s.value.length;
      return { ...s, value: s.value.slice(0, c) + key + s.value.slice(c), cursor: c + 1 };
    }
    if (key === 'backspace') {
      const c = s.cursor ?? s.value.length;
      return { ...s, value: s.value.slice(0, Math.max(0, c - 1)) + s.value.slice(c), cursor: Math.max(0, c - 1) };
    }
    return s;
  }
  // normal mode
  switch (key) {
    case 'i': return { ...s, mode: 'insert', cursor: s.cursor ?? s.value.length };
    case 'a': return { ...s, mode: 'insert', cursor: (s.cursor ?? s.value.length) + 1 };
    case 'escape': return { ...s, pending: undefined };
    case 'x': {
      const c = s.cursor ?? 0;
      return { ...s, value: s.value.slice(0, c) + s.value.slice(c + 1), cursor: c };
    }
    case 'd':
      if (s.pending === 'd') return { ...s, value: '', cursor: 0, pending: undefined };
      return { ...s, pending: 'd' };
    case 'h': return { ...s, cursor: Math.max(0, (s.cursor ?? 0) - 1) };
    case 'l': return { ...s, cursor: Math.min(s.value.length, (s.cursor ?? 0) + 1) };
    case '0': return { ...s, cursor: 0 };
    case '$': return { ...s, cursor: s.value.length };
    case 'u': return s; // undo 由上层历史栈处理
    default: return { ...s, pending: undefined };
  }
}
