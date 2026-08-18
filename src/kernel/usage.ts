// src/kernel/usage.ts — token 消耗区间聚合（跨会话；状态栏 📊 数据源）
/** 结构化最小端口（presentation 窄端口亦可调用——真实 Db 自然满足） */
export type UsageDb = { prepare(sql: string): { get(...a: unknown[]): unknown } };

export type UsageRange = 'today' | '7d' | '30d';
export const USAGE_RANGES: UsageRange[] = ['today', '7d', '30d'];

/** 区间起点毫秒（today=本地零点；7d/30d=滚动窗口） */
export function usageRangeSince(range: UsageRange, now: Date = new Date()): number {
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === '7d' ? 7 : 30;
  return now.getTime() - days * 86_400_000;
}

export interface UsageSummary {
  input: number;
  output: number;
  total: number;
  calls: number;
  unmeasured: number;
  /** 前缀缓存命中 token（DeepSeek 自动缓存；端点未上报时 0） */
  cacheHit: number;
  /** 前缀缓存未命中 token（端点未上报时 0） */
  cacheMiss: number;
  /** 推理 token（completion_tokens_details.reasoning_tokens；端点未上报时 0）——成本五维 */
  reasoning: number;
}

export function usageSummary(db: UsageDb, range: UsageRange): UsageSummary {
  const since = usageRangeSince(range);
  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) c,
            COALESCE(SUM(CASE WHEN input_tokens=0 AND output_tokens=0 THEN 1 ELSE 0 END),0) u,
            COALESCE(SUM(cache_hit_tokens),0) ch, COALESCE(SUM(cache_miss_tokens),0) cm,
            COALESCE(SUM(reasoning_tokens),0) rn
     FROM usage_stats WHERE ts >= ?`
  ).get(since) as { i: number; o: number; c: number; u: number; ch: number; cm: number; rn: number };
  return { input: row.i, output: row.o, total: row.i + row.o, calls: row.c, unmeasured: row.u, cacheHit: row.ch, cacheMiss: row.cm, reasoning: row.rn };
}
