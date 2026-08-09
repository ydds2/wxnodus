// src/ui/components/inputHistory.ts — L6-2 输入历史（纯逻辑：push/prev/next，上限 1000 去重）
export function createHistory(initial: string[] = []) {
  const items = [...initial].slice(-1000);
  let idx = items.length;
  let draft = '';
  return {
    size: () => items.length,
    push(s: string) {
      const v = s.trim();
      if (!v) return;
      if (items[items.length - 1] === v) return;
      items.push(v);
      if (items.length > 1000) items.shift();
      idx = items.length;
    },
    prev(): string | undefined {
      if (!items.length) return undefined;
      if (idx === items.length) { draft = ''; idx--; }
      else if (idx > 0) idx--;
      return items[idx];
    },
    next(): string | undefined {
      if (idx >= items.length) return draft;
      idx++;
      return idx === items.length ? draft : items[idx];
    },
    reset() { idx = items.length; },
  };
}
