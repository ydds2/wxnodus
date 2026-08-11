// tests/kernel-tools.test.ts — cron_create 工具（Claude Code CronCreate 对齐）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreTools } from '../src/kernel/tools.js';
import { openDB, closeDB } from '../src/store/db.js';

describe('cron_create 工具', () => {
  it('真实写入 cron_jobs 表并返回任务 ID；参数校验拒绝非法输入', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-cron-'));
    const db = openDB(d);
    try {
      const tools = coreTools();
      const t = tools.cron_create!;
      // 参数校验
      expect(await t.run({ intervalMinutes: 0, action: 'x' }, { db } as any)).toContain('参数错误');
      expect(await t.run({ intervalMinutes: 5, action: '' }, { db } as any)).toContain('参数错误');
      // 真实创建
      const out = await t.run({ intervalMinutes: 30, action: '检查依赖更新并报告' }, { db } as any);
      expect(out).toMatch(/定时任务已创建 #\d+/);
      const rows = db.prepare(`SELECT schedule, action, enabled FROM cron_jobs`).all() as Array<{ schedule: string; action: string; enabled: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ schedule: 'every 30m', action: '检查依赖更新并报告', enabled: 1 });
      // 无 db → 明确不可用提示
      expect(await t.run({ intervalMinutes: 5, action: 'x' }, {} as any)).toContain('不可用');
    } finally {
      closeDB(db);
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
});
