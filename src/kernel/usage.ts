// src/kernel/usage.ts — token 消耗区间聚合（跨会话；状态栏 📊 数据源）
import type { Db } from '../store/db.js';

export type UsageRange = 'today' | '7d' | '30d';
export const USAGE_RANGES: UsageRange[] = ['today', '7d', '30d'];

/** 区间起点毫秒（today=本地零点；7d/30d=滚动窗口） */
export function usageRangeSince(range: UsageRange, now: Date = new Date()): number {
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === '7d' ? 7 : 30;
  return now.getTime() - days * 86_400_000;
}

export interface UsageSummary { input: number; output: number; total: number; calls: number; unmeasured: number }

export function usageSummary(db: Db, range: UsageRange): UsageSummary {
  const since = usageRangeSince(range);
  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) c,
            COALESCE(SUM(CASE WHEN input_tokens=0 AND output_tokens=0 THEN 1 ELSE 0 END),0) u
     FROM usage_stats WHERE ts >= ?`
  ).get(since) as { i: number; o: number; c: number; u: number };
  return { input: row.i, output: row.o, total: row.i + row.o, calls: row.c, unmeasured: row.u };
}
