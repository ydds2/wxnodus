// src/wxnodus-ui/lib/historySearch.ts — Ctrl+R 反向历史搜索（纯函数）
// 从 beforeIndex 向前（更旧）查找第一个包含 query 的条目（大小写不敏感子串）；
// 空 query → 最近一条。找不到 → null（调用方决定环绕或停步）。
export function searchHistory(history: readonly string[], query: string, beforeIndex: number): { index: number; text: string } | null {
  const q = query.toLowerCase();
  const end = beforeIndex < 0 ? history.length : Math.min(beforeIndex, history.length);
  for (let i = end - 1; i >= 0; i--) {
    if (history[i]!.toLowerCase().includes(q)) {
      return { index: i, text: history[i]! };
    }
  }
  return null;
}

/** 环绕搜索：before 之前无匹配则从末尾重试（bash readline 行为——Ctrl+R 循环一圈）。 */
export function searchHistoryWrapped(history: readonly string[], query: string, beforeIndex: number): { index: number; text: string } | null {
  return searchHistory(history, query, beforeIndex) ?? (beforeIndex >= 0 ? searchHistory(history, query, history.length) : null);
}
