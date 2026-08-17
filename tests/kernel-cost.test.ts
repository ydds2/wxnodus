// tests/kernel-cost.test.ts — /cost 成本估算（纯函数）
import { describe, it, expect } from 'vitest';
import { estimateCost, costSummary, priceForModel } from '../src/kernel/cost.js';

describe('estimateCost 成本估算', () => {
  it('按参考价目计算（USD）', () => {
    // deepseek-chat：1M in + 1M out = 0.28 + 0.42 = 0.70
    expect(estimateCost('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(0.7, 6);
    // 半量：500k in + 250k out
    expect(estimateCost('deepseek-chat', 500_000, 250_000)).toBeCloseTo(0.14 + 0.105, 6);
  });

  it('免费模型 0；未知模型 null（绝不编价格）', () => {
    expect(estimateCost('glm-4-flash', 10_000_000, 10_000_000)).toBe(0);
    expect(estimateCost('glm-4v-flash', 999, 999)).toBe(0);
    expect(estimateCost('deepseek-v4-pro', 1, 1)).toBeNull();
    expect(estimateCost('random-model', 1, 1)).toBeNull();
  });

  it('priceForModel 快照', () => {
    expect(priceForModel('deepseek-chat')).toEqual({ in: 0.28, out: 0.42 });
    expect(priceForModel('glm-4-flash')).toEqual({ in: 0, out: 0 });
    expect(priceForModel('unknown')).toBeNull();
  });
});

describe('costSummary 聚合', () => {
  it('按模型分组 + 总计 + 未知计数', () => {
    const s = costSummary([
      { model: 'deepseek-chat', input: 1_000_000, output: 1_000_000 },
      { model: 'deepseek-chat', input: 500_000, output: 0 },
      { model: 'glm-4-flash', input: 100, output: 200 },
      { model: 'deepseek-v4-pro', input: 10, output: 10 },
    ]);
    const ds = s.rows.find(r => r.model === 'deepseek-chat')!;
    expect(ds.input).toBe(1_500_000);
    expect(ds.usd).toBeCloseTo(0.28 * 1.5 + 0.42, 6);
    expect(s.rows.find(r => r.model === 'glm-4-flash')!.usd).toBe(0);
    expect(s.rows.find(r => r.model === 'deepseek-v4-pro')!.usd).toBeNull();
    expect(s.unknownCount).toBe(1);
    expect(s.totalUsd).toBeCloseTo(0.28 * 1.5 + 0.42, 6);
  });

  it('空输入 → 空行零总计', () => {
    const s = costSummary([]);
    expect(s.rows).toEqual([]);
    expect(s.totalUsd).toBe(0);
    expect(s.unknownCount).toBe(0);
  });
});

describe('costPrices 自定义价目覆盖', () => {
  it('覆盖优先于公开价目；free 归零；未知仍 null', () => {
    expect(estimateCost('deepseek-chat', 1_000_000, 1_000_000, { 'deepseek-chat': { in: 0.1, out: 0.2 } })).toBeCloseTo(0.3, 6);
    expect(estimateCost('glm-4.5', 1_000_000, 1_000_000, { 'glm-4.5': 'free' })).toBe(0);
    expect(estimateCost('mystery', 1, 1, {})).toBeNull();
    // 无覆盖时走默认价目
    expect(estimateCost('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(0.7, 6);
  });
  it('costSummary 覆盖影响总计与 unknown 判定', () => {
    const s = costSummary(
      [{ model: 'mystery', input: 1_000_000, output: 0 }],
      { mystery: { in: 0.5, out: 0.5 } }
    );
    expect(s.unknownCount).toBe(0);
    expect(s.totalUsd).toBeCloseTo(0.5, 6);
  });
});
