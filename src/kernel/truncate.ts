// src/kernel/truncate.ts — 结果截断单一事实源（工具诚实性红线）
// 口径：任何面向模型的内容截断都必须显式标注「已截断（共 N 字，剩余 M 字未读）」，
// 可选续查提示——绝不静默截断（否则模型误判「内容到此为止」）。
export function labelTruncate(text: string, limit: number, hint?: string): string {
  if (text.length <= limit) return text;
  const suffix = hint ? `——${hint}` : '';
  return `${text.slice(0, limit)}…[已截断（共 ${text.length} 字，剩余 ${text.length - limit} 字未读）${suffix}]`;
}
