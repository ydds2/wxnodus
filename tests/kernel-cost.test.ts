// tests/kernel-cost.test.ts — /cost 成本估算（纯函数 + costQuery 数据库助手）
import { describe, it, expect } from 'vitest';
import { estimateCost, costSummary, priceForModel, estimateCostMicroUsd } from '../src/kernel/cost.js';
import { sessionCost, rangeCost, costText } from '../src/kernel/costQuery.js';
import { openDB } from '../src/store/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(priceForModel('deepseek-chat')).toEqual({ in: 0.28, out: 0.42, cacheRead: 0.07 });
    expect(priceForModel('glm-4-flash')).toEqual({ in: 0, out: 0 });
    expect(priceForModel('unknown')).toBeNull();
  });
});

describe('成本五维 + 整数分计价（supremacy 1.4）', () => {
  it('estimateCostMicroUsd：五维全量计价（缓存读走 cacheRead 价，推理按输出价）', () => {
    // deepseek-chat：1M in（0.28）+ 1M out（0.42）+ 1M cacheHit（0.07）+ 1M cacheMiss（0.28）+ 1M reasoning（0.42）
    const micro = estimateCostMicroUsd('deepseek-chat', { input: 1_000_000, output: 1_000_000, cacheHit: 1_000_000, cacheMiss: 1_000_000, reasoning: 1_000_000 });
    expect(micro).toBe(1_470_000); // 1.47 USD 的整数 µUSD 表示
  });
  it('整数分：1M token × 0.07 缓存读价 = 精确 70000 µUSD（无浮点尾差）', () => {
    expect(estimateCostMicroUsd('deepseek-chat', { input: 0, output: 0, cacheHit: 1_000_000 })).toBe(70_000);
    // 非整 token 数也走 BigInt 定点：3 token × 280000 µUSD/1M = 0.84 µUSD → 四舍五入 1
    expect(estimateCostMicroUsd('deepseek-chat', { input: 3, output: 0 })).toBe(1);
  });
  it('未收录 cacheRead 的模型：缓存读按输入价保守估算（高估不低估）', () => {
    // kimi-k2.7 无 cacheRead 价 → 1M cacheHit 按 0.6 计
    expect(estimateCostMicroUsd('kimi-k2.7', { input: 0, output: 0, cacheHit: 1_000_000 })).toBe(600_000);
  });
  it('免费模型五维全 0；未知模型 null', () => {
    expect(estimateCostMicroUsd('glm-4-flash', { input: 10_000_000, output: 10_000_000, cacheHit: 1, cacheMiss: 1, reasoning: 1 })).toBe(0);
    expect(estimateCostMicroUsd('unknown', { input: 1, output: 1 })).toBeNull();
  });
  it('costSummary 聚合五维并输出明细维度', () => {
    const s = costSummary([
      { model: 'deepseek-chat', input: 1_000_000, output: 0, cacheHit: 2_000_000, cacheMiss: 0, reasoning: 0 },
      { model: 'deepseek-chat', input: 0, output: 1_000_000, cacheHit: 0, cacheMiss: 1_000_000, reasoning: 1_000_000 },
    ]);
    const ds = s.rows.find(r => r.model === 'deepseek-chat')!;
    expect(ds.input).toBe(1_000_000);
    expect(ds.cacheHit).toBe(2_000_000);
    expect(ds.cacheMiss).toBe(1_000_000);
    expect(ds.reasoning).toBe(1_000_000);
    // 0.28 + 0.14 + 0.28 + 0.42 + 0.42 = 1.54
    expect(ds.usd).toBeCloseTo(1.54, 6);
    expect(s.totalUsd).toBeCloseTo(1.54, 6);
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

describe('costQuery 未上报用量排除（端点无 usage 的 0 token 行不参与成本明细）', () => {
  it('sessionCost：0 token 行不计入模型明细（不误标免费/离线），已上报行正常计费', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-cq-'));
    try {
      const db = openDB(dir);
      const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`);
      ins.run('s1', 'deepseek-chat', 1000, 500, Date.now());
      ins.run('s1', 'mystery-model', 0, 0, Date.now()); // 未上报用量——不得出现在明细
      const q = sessionCost(db, 's1');
      expect(q).not.toBeNull();
      expect(q!.models).toBe(1);
      expect(q!.rows.map(r => r.model)).toEqual(['deepseek-chat']);
      expect(costText(q)).not.toContain('起');
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rangeCost：同一 SQL 口径；全 0 token → null（无数据，不报 $0）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-cq2-'));
    try {
      const db = openDB(dir);
      db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`)
        .run('s1', 'mystery-model', 0, 0, Date.now());
      expect(rangeCost(db, 0)).toBeNull();
      expect(costText(null)).toBe('');
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
