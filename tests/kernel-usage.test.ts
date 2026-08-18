import { describe, it, expect } from 'vitest';
import { usageRangeSince, usageSummary } from '../src/kernel/usage.js';
import { openDB } from '../src/store/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('usage', () => {
  it('usageRangeSince: today=本地零点', () => {
    const now = new Date(2026, 7, 17, 15, 30); // 2026-08-17 15:30 本地
    const since = usageRangeSince('today', now);
    expect(since).toBe(new Date(2026, 7, 17, 0, 0).getTime());
  });
  it('usageRangeSince: 7d/30d 滚动窗口', () => {
    const now = new Date(2026, 7, 17, 12, 0);
    expect(usageRangeSince('7d', now)).toBe(now.getTime() - 7 * 86_400_000);
    expect(usageRangeSince('30d', now)).toBe(now.getTime() - 30 * 86_400_000);
  });
  it('usageSummary: 跨会话聚合 + 区间过滤', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-usage-'));
    try {
      const db = openDB(dir);
      const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`);
      ins.run('s1', 'm1', 100, 50, Date.now());
      ins.run('s2', 'm2', 300, 150, Date.now());
      ins.run('s3', 'm3', 1000, 500, Date.now() - 40 * 86_400_000); // 40 天前→排除
      const s = usageSummary(db, '30d');
      expect(s).toEqual({ input: 400, output: 200, total: 600, calls: 2, unmeasured: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0 });
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('usageSummary: 端点未上报用量的调用（0 token 行）单独计数——调用数诚实、token 不虚高', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-usage-'));
    try {
      const db = openDB(dir);
      const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`);
      ins.run('s1', 'm1', 100, 50, Date.now());
      ins.run('s1', 'm1', 0, 0, Date.now()); // 未上报用量
      const s = usageSummary(db, 'today');
      expect(s.calls).toBe(2); // 调用计数诚实（含未上报）
      expect(s.unmeasured).toBe(1);
      expect(s.total).toBe(150); // token 只统计已上报——绝不虚高
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('usageSummary: 前缀缓存命中/未命中聚合（端点上报时；未上报列默认 0）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-usage-'));
    try {
      const db = openDB(dir);
      const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, ts) VALUES (?,?,?,?,?,?,?)`);
      ins.run('s1', 'm1', 1000, 50, 800, 200, Date.now()); // 命中 800/未命中 200
      ins.run('s1', 'm1', 500, 25, 0, 0, Date.now()); // 未上报缓存字段 → 0
      const s = usageSummary(db, 'today');
      expect(s.cacheHit).toBe(800);
      expect(s.cacheMiss).toBe(200);
      expect(s.reasoning).toBe(0);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('usageSummary: 推理 token 聚合（成本五维——端点上报时）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-usage-'));
    try {
      const db = openDB(dir);
      const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, reasoning_tokens, ts) VALUES (?,?,?,?,?,?)`);
      ins.run('s1', 'm1', 500, 100, 80, Date.now());
      ins.run('s1', 'm1', 100, 20, 0, Date.now()); // 未上报推理字段 → 0
      const s = usageSummary(db, 'today');
      expect(s.reasoning).toBe(80);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
