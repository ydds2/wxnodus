// src/kernel/costQuery.ts — 成本查询共享助手（/cost /status /context /digest /sessions /arena /usage 同源）
// 单一 SQL 事实源：会话/区间按模型聚合 → costSummary（全部模型有定价才给合计，
// 未知计数独立返回——调用方自行决定「起」口径，绝不显示被低估的数字）。
import type { Db } from '../store/db.js';
import { costSummary } from './cost.js';

export interface CostQueryResult {
  /** 已定价模型合计（USD）；全部模型有定价时才可信 */
  usd: number;
  /** 未收录定价的模型数 */
  unknown: number;
  tokens: { input: number; output: number; total: number };
  /** 参与统计的模型数 */
  models: number;
  /** 按模型明细（/cost 表格渲染同源） */
  rows: Array<{ model: string; input: number; output: number; usd: number | null }>;
}

export type CostOverrides = Record<string, { in: number; out: number } | 'free'> | null | undefined;

const summarize = (rows: Array<{ model: string; input: number; output: number }>, overrides: CostOverrides): CostQueryResult | null => {
  if (!rows.length) return null;
  const s = costSummary(rows, overrides);
  const tokens = rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, total: a.total + r.input + r.output }), { input: 0, output: 0, total: 0 });
  return { usd: s.totalUsd, unknown: s.unknownCount, tokens, models: rows.length, rows: s.rows };
};

/** 会话成本（session_id） */
export function sessionCost(db: Db, sessionId: string, overrides?: CostOverrides): CostQueryResult | null {
  try {
    const rows = db.prepare(
      `SELECT model, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM usage_stats WHERE session_id=? GROUP BY model`
    ).all(sessionId) as Array<{ model: string; input: number; output: number }>;
    return summarize(rows, overrides);
  } catch { return null; }
}

/** 区间成本（ts >= since，跨会话） */
export function rangeCost(db: Db, since: number, overrides?: CostOverrides): CostQueryResult | null {
  try {
    const rows = db.prepare(
      `SELECT model, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM usage_stats WHERE ts >= ? GROUP BY model`
    ).all(since) as Array<{ model: string; input: number; output: number }>;
    return summarize(rows, overrides);
  } catch { return null; }
}

/** 统一文案：`$1.2345` / `$1.2345 起（2 个模型未收录定价）` / ''（无数据） */
export function costText(q: CostQueryResult | null): string {
  if (!q) return '';
  return q.unknown === 0 ? `$${q.usd.toFixed(4)}` : `$${q.usd.toFixed(4)} 起（${q.unknown} 个模型未收录定价）`;
}
