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
      expect(s).toEqual({ input: 400, output: 200, total: 600, calls: 2 });
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
