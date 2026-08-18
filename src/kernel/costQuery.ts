// src/kernel/costQuery.ts — 成本查询共享助手（/cost /status /context /digest /sessions /arena /usage 同源）
// 单一 SQL 事实源：会话/区间按模型聚合 → costSummary（全部模型有定价才给合计，
// 未知计数独立返回——调用方自行决定「起」口径，绝不显示被低估的数字）。
import { costSummary } from './cost.js';

/** 结构化最小端口（presentation 窄端口亦可调用——真实 Db 自然满足） */
export type CostDb = { prepare(sql: string): { all(...a: unknown[]): unknown[] } };

export interface CostQueryResult {
  /** 已定价模型合计（USD）；全部模型有定价时才可信 */
  usd: number;
  /** 未收录定价的模型数 */
  unknown: number;
  tokens: { input: number; output: number; total: number };
  /** 成本五维扩展（supremacy 1.4）：缓存读/写、推理 token 总量 */
  dims: { cacheHit: number; cacheMiss: number; reasoning: number };
  /** 前缀缓存净节省（USD，相对无缓存基准；官方公布价才有正节省，可负=写价上浮） */
  cacheSavingsUsd: number;
  /** 参与统计的模型数 */
  models: number;
  /** 按模型明细（/cost 表格渲染同源） */
  rows: Array<{ model: string; input: number; output: number; cacheHit: number; cacheMiss: number; reasoning: number; usd: number | null }>;
}

export type CostOverrides = Record<string, { in: number; out: number; cacheRead?: number } | 'free'> | null | undefined;

const summarize = (rows: Array<{ model: string; input: number; output: number; cacheHit: number; cacheMiss: number; reasoning: number }>, overrides: CostOverrides): CostQueryResult | null => {
  if (!rows.length) return null;
  const s = costSummary(rows, overrides);
  const tokens = rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, total: a.total + r.input + r.output }), { input: 0, output: 0, total: 0 });
  const dims = rows.reduce((a, r) => ({ cacheHit: a.cacheHit + r.cacheHit, cacheMiss: a.cacheMiss + r.cacheMiss, reasoning: a.reasoning + r.reasoning }), { cacheHit: 0, cacheMiss: 0, reasoning: 0 });
  return { usd: s.totalUsd, unknown: s.unknownCount, tokens, dims, cacheSavingsUsd: s.cacheSavingsUsd, models: rows.length, rows: s.rows };
};

/** 会话成本（session_id；0 token 行=端点未上报用量——不计入明细，防误标「免费/离线」） */
export function sessionCost(db: CostDb, sessionId: string, overrides?: CostOverrides): CostQueryResult | null {
  try {
    const rows = db.prepare(
      `SELECT model, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_hit_tokens),0) AS cacheHit, COALESCE(SUM(cache_miss_tokens),0) AS cacheMiss,
              COALESCE(SUM(reasoning_tokens),0) AS reasoning
         FROM usage_stats WHERE session_id=? AND (input_tokens>0 OR output_tokens>0) GROUP BY model`
    ).all(sessionId) as Array<{ model: string; input: number; output: number; cacheHit: number; cacheMiss: number; reasoning: number }>;
    return summarize(rows, overrides);
  } catch { return null; }
}

/** 区间成本（ts >= since，跨会话；0 token 行同样排除） */
export function rangeCost(db: CostDb, since: number, overrides?: CostOverrides): CostQueryResult | null {
  try {
    const rows = db.prepare(
      `SELECT model, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_hit_tokens),0) AS cacheHit, COALESCE(SUM(cache_miss_tokens),0) AS cacheMiss,
              COALESCE(SUM(reasoning_tokens),0) AS reasoning
         FROM usage_stats WHERE ts >= ? AND (input_tokens>0 OR output_tokens>0) GROUP BY model`
    ).all(since) as Array<{ model: string; input: number; output: number; cacheHit: number; cacheMiss: number; reasoning: number }>;
    return summarize(rows, overrides);
  } catch { return null; }
}

/** 统一文案：`$1.2345` / `$1.2345 起（2 个模型未收录定价）` / `$1.2345（缓存节省 $0.0312）` / ''（无数据） */
export function costText(q: CostQueryResult | null): string {
  if (!q) return '';
  const base = q.unknown === 0 ? `$${q.usd.toFixed(4)}` : `$${q.usd.toFixed(4)} 起（${q.unknown} 个模型未收录定价）`;
  // 前缀缓存净节省（相对无缓存基准；只有官方公布缓存价目且净节省 >0 才展示——绝不虚报）
  if (q.cacheSavingsUsd > 0) return `${base}（缓存节省 $${q.cacheSavingsUsd.toFixed(4)}）`;
  return base;
}
