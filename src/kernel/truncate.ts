// src/kernel/truncate.ts — 结果截断单一事实源（工具诚实性红线）
// 口径：任何面向模型的内容截断都必须显式标注「已截断（共 N 字，剩余 M 字未读）」，
// 可选续查提示——绝不静默截断（否则模型误判「内容到此为止」）。
export function labelTruncate(text: string, limit: number, hint?: string): string {
  if (text.length <= limit) return text;
  const suffix = hint ? `——${hint}` : '';
  return `${text.slice(0, limit)}…[已截断（共 ${text.length} 字，剩余 ${text.length - limit} 字未读）${suffix}]`;
}

/** 列表封顶标注：超限时告知总数与前 M 个；未超限返回空串（枚举类工具输出必须有界且诚实） */
export function capNote(total: number, cap: number, hint?: string): string {
  if (total <= cap) return '';
  const suffix = hint ? `——${hint}` : '';
  return `…[共 ${total} 个，已截断（前 ${cap} 个）${suffix}]`;
}
