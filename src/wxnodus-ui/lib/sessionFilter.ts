// src/wxnodus-ui/lib/sessionFilter.ts — 会话浏览器搜索过滤（P1 收尾，2026-08-20）
// 纯函数：大小写不敏感子串匹配（id/title/preview）；供 activeSessionSwitcher 过滤可恢复会话。
// 诚实口径：过滤只作用于可恢复会话列表——live 会话常驻显示不参与过滤。

export interface SessionFilterRow {
  id: string
  title?: string
  preview?: string
}

/** 单行匹配（id/title/preview 任一命中即通过） */
export function matchSessionFilter(id: string, title: string, preview: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${id} ${title} ${preview}`.toLowerCase().includes(q)
}

/** 行过滤（query 空 → 原数组返回，零拷贝；泛型保留行完整类型——调用方行字段不丢失） */
export function filterSessionRows<T extends SessionFilterRow>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows as T[]
  return rows.filter(r => matchSessionFilter(r.id, r.title ?? '', r.preview ?? '', q))
}
