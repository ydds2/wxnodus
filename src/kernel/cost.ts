// src/kernel/cost.ts — 会话/区间 token 成本估算（/cost 命令数据源）
// 诚实口径：价格为公开参考价目（USD / 1M token），可能与实际账单有出入——输出必带
// 「估算」标注；未收录定价的模型只报 token 不报金额（绝不编价格）；免费/离线模型 0。
// supremacy 1.4（成本五维 + 整数分计价，机制参考 opencode 五维用量——实现原创）：
//  - 五维：input / output / cacheHit（前缀缓存读）/ cacheMiss（前缀缓存写）/ reasoning（推理）。
//  - 整数分计价：全部金额以**整数微美元（µUSD）**累加（BigInt 定点运算），杜绝浮点累加漂移；
//    只在最终展示层换算为 USD 小数——分以下永不出现 0.30000000000000004 类误差。
export interface CostRow {
  model: string;
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  reasoning: number;
  /** 估算成本（USD）；定价未知 → null */
  usd: number | null;
}

/** 五维 token 用量（缺省维度视为 0） */
export interface CostDims {
  input: number;
  output: number;
  cacheHit?: number;
  cacheMiss?: number;
  reasoning?: number;
}

/** 价格档（USD / 1M token）；cacheRead 为前缀缓存读价（未收录 → 按输入价保守计，见注释） */
export interface PriceEntry {
  in: number;
  out: number;
  /** 缓存读价（USD/1M）；DeepSeek 官方公布快照收录，其余未收录 */
  cacheRead?: number;
}

// 参考价目（USD / 1M token）——公开牌价快照，非实时账单
// cacheRead：仅收录官方公布价（DeepSeek chat 0.07 / reasoner 0.14）；未收录的模型
// 缓存读按输入价保守估算（高估不低估——costText 已带「估算」标注）
export const MODEL_PRICES: Record<string, PriceEntry | 'free'> = {
  'deepseek-chat': { in: 0.28, out: 0.42, cacheRead: 0.07 },
  'deepseek-reasoner': { in: 0.55, out: 2.19, cacheRead: 0.14 },
  'glm-4-flash': 'free',
  'glm-4v-flash': 'free',
  'glm-4.5': { in: 0.55, out: 2.2 },
  'kimi-k2.7': { in: 0.6, out: 2.5 },
  'kimi-k2.7-highspeed': { in: 0.6, out: 2.5 },
};

/** 价格单位换算：USD/1M → 整数 µUSD/1M（四舍五入；0.07 → 70000） */
const toMicro = (usdPer1M: number): number => Math.round(usdPer1M * 1_000_000);

/** 定点成本：tokens × priceMicro / 1M，四舍五入到整数 µUSD（BigInt 全整数运算，零浮点漂移） */
function microFor(tokens: number, priceMicro: number): number {
  const t = Math.max(0, Math.trunc(tokens));
  return Number((BigInt(t) * BigInt(priceMicro) + 500_000n) / 1_000_000n);
}

export const priceForModel = (model: string, overrides?: Record<string, PriceEntry | 'free'> | null): PriceEntry | null => {
  // 自定义价目优先（settings.costPrices——中转站/私有定价档；用户显式配置才生效）
  const custom = overrides?.[model];
  if (custom === 'free') return { in: 0, out: 0 };
  if (custom) return custom;
  const p = MODEL_PRICES[model];
  if (p === 'free') return { in: 0, out: 0 };
  return p ?? null;
};

/** 五维成本估算 → 整数 µUSD；定价未知 → null（诚实不编）；免费 → 0。
 *  计价映射（行业标准口径）：
 *  - input × 输入价；output × 输出价；reasoning × 输出价（推理 token 按输出计费）
 *  - cacheMiss × 输入价（前缀缓存写按输入价计，行业一致）
 *  - cacheHit × 缓存读价（未收录 → 输入价保守估） */
export function estimateCostMicroUsd(model: string, dims: CostDims, overrides?: Record<string, PriceEntry | 'free'> | null): number | null {
  const p = priceForModel(model, overrides);
  if (!p) return null;
  const inMicro = toMicro(p.in);
  const outMicro = toMicro(p.out);
  const cacheReadMicro = toMicro(p.cacheRead ?? p.in); // 未收录缓存读价 → 按输入价保守估算
  return microFor(dims.input, inMicro)
    + microFor(dims.output, outMicro)
    + microFor(dims.cacheHit ?? 0, cacheReadMicro)
    + microFor(dims.cacheMiss ?? 0, inMicro)
    + microFor(dims.reasoning ?? 0, outMicro);
}

/** 兼容入口（两维）→ USD 小数（内部走整数 µUSD 定点，仅展示层换算） */
export function estimateCost(model: string, inputTokens: number, outputTokens: number, overrides?: Record<string, PriceEntry | 'free'> | null): number | null {
  const micro = estimateCostMicroUsd(model, { input: inputTokens, output: outputTokens }, overrides);
  return micro === null ? null : micro / 1_000_000;
}

/** 聚合行（按模型分组，五维）→ 成本行 + 总计（costPrices 自定义价目优先） */
export function costSummary(
  rows: Array<{ model: string; input: number; output: number; cacheHit?: number; cacheMiss?: number; reasoning?: number }>,
  overrides?: Record<string, PriceEntry | 'free'> | null,
): { rows: CostRow[]; totalUsd: number; unknownCount: number } {
  const byModel = new Map<string, { input: number; output: number; cacheHit: number; cacheMiss: number; reasoning: number }>();
  for (const r of rows) {
    const cur = byModel.get(r.model) ?? { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0 };
    cur.input += r.input;
    cur.output += r.output;
    cur.cacheHit += r.cacheHit ?? 0;
    cur.cacheMiss += r.cacheMiss ?? 0;
    cur.reasoning += r.reasoning ?? 0;
    byModel.set(r.model, cur);
  }
  let totalMicro = 0; // 整数 µUSD 累加——零浮点漂移
  let unknownCount = 0;
  const out: CostRow[] = [];
  for (const [model, v] of byModel) {
    const micro = estimateCostMicroUsd(model, v, overrides);
    if (micro === null) unknownCount += 1;
    else totalMicro += micro;
    out.push({
      model,
      input: v.input,
      output: v.output,
      cacheHit: v.cacheHit ?? 0,
      cacheMiss: v.cacheMiss ?? 0,
      reasoning: v.reasoning ?? 0,
      usd: micro === null ? null : micro / 1_000_000, // 仅展示层换算
    });
  }
  return { rows: out, totalUsd: totalMicro / 1_000_000, unknownCount };
}
