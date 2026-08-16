// src/kernel/jsonPath.ts — 零依赖点路径取值（余额 jsonPath 兜底：a.b[0].c）
export function getByPath(obj: unknown, path: string): unknown {
  const parts = String(path ?? '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(s => s.trim())
    .filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}
