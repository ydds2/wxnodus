// src/kernel/cost.ts — 会话/区间 token 成本估算（/cost 命令数据源）
// 诚实口径：价格为公开参考价目（USD / 1M token），可能与实际账单有出入——输出必带
// 「估算」标注；未收录定价的模型只报 token 不报金额（绝不编价格）；免费/离线模型 0。
export interface CostRow {
  model: string;
  input: number;
  output: number;
  /** 估算成本（USD）；定价未知 → null */
  usd: number | null;
}

// 参考价目（USD / 1M token）——公开牌价快照，非实时账单
export const MODEL_PRICES: Record<string, { in: number; out: number } | 'free'> = {
  'deepseek-chat': { in: 0.28, out: 0.42 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'glm-4-flash': 'free',
  'glm-4v-flash': 'free',
  'glm-4.5': { in: 0.55, out: 2.2 },
  'kimi-k2.7': { in: 0.6, out: 2.5 },
  'kimi-k2.7-highspeed': { in: 0.6, out: 2.5 },
};

export const priceForModel = (model: string): { in: number; out: number } | null => {
  const p = MODEL_PRICES[model];
  if (p === 'free') return { in: 0, out: 0 };
  return p ?? null;
};

/** 单模型成本估算：定价未知 → null（诚实不编） */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = priceForModel(model);
  if (!p) return null;
  return (inputTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
}

/** 聚合行（按模型分组）→ 成本行 + 总计 */
export function costSummary(rows: Array<{ model: string; input: number; output: number }>): { rows: CostRow[]; totalUsd: number; unknownCount: number } {
  const byModel = new Map<string, { input: number; output: number }>();
  for (const r of rows) {
    const cur = byModel.get(r.model) ?? { input: 0, output: 0 };
    cur.input += r.input;
    cur.output += r.output;
    byModel.set(r.model, cur);
  }
  let totalUsd = 0;
  let unknownCount = 0;
  const out: CostRow[] = [];
  for (const [model, v] of byModel) {
    const usd = estimateCost(model, v.input, v.output);
    if (usd === null) unknownCount += 1;
    else totalUsd += usd;
    out.push({ model, input: v.input, output: v.output, usd });
  }
  return { rows: out, totalUsd, unknownCount };
}
