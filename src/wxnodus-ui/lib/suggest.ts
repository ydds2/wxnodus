// src/ui/lib/suggest.ts — 命令建议过滤（纯函数，可单测）
// 设计（参考 Claude Code / DeepSeek CLI 内联命令建议）：输入 / 开头时
// 按前缀精确匹配 + fuzzysort 子序列模糊匹配，返回建议命令列表。
import fuzzysort from 'fuzzysort';

export function filterCommands(q: string, list: string[]): string[] {
  if (!q) return list.slice(0, 6);
  const exact = list.filter(c => c.startsWith(q));
  const fuzzy = fuzzysort.go(q, list, { limit: 6 }).map(r => r.target);
  return [...new Set([...exact, ...fuzzy])].slice(0, 6);
}

// 判断输入是否处于命令建议态（/ 开头且未带空格参数）
export function isSuggesting(value: string): boolean {
  return value.startsWith('/') && !value.includes(' ') && value.length > 0;
}
