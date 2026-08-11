// tests/kernel-tools.test.ts — cron_create 工具（Claude Code CronCreate 对齐）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// ── P0 建议落地：find_files / memory_search 工具 ──
describe('find_files 文件搜索', () => {
  it('glob 匹配 + 跳过黑名单目录', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-ff-'));
    try {
      mkdirSync(join(d, 'src'), { recursive: true });
      mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(d, 'dist'), { recursive: true });
      writeFileSync(join(d, 'src', 'a.test.ts'), 'x');
      writeFileSync(join(d, 'src', 'b.ts'), 'x');
      writeFileSync(join(d, 'config.json'), '{}');
      writeFileSync(join(d, 'node_modules', 'pkg', 'x.test.ts'), 'x');
      writeFileSync(join(d, 'dist', 'y.test.ts'), 'x');
      const t = coreTools().find_files!;
      const out1 = await t.run({ pattern: '*.test.ts' }, { cwd: d } as any);
      expect(out1).toContain('a.test.ts');
      expect(out1).not.toContain('x.test.ts'); // node_modules 跳过
      expect(out1).not.toContain('y.test.ts'); // dist 跳过
      const out2 = await t.run({ pattern: 'config.json' }, { cwd: d } as any);
      expect(out2).toContain('config.json');
      const out3 = await t.run({ pattern: 'nope*' }, { cwd: d } as any);
      expect(out3).toContain('未找到');
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

describe('memory_search 黑洞检索', () => {
  it('FTS5 检索历史记忆（真实 DB）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-ms-'));
    const db = openDB(d);
    try {
      // 写入历史消息（会话 s1）
      db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`).run('s1', '测试', Date.now(), Date.now());
      db.prepare(`INSERT INTO messages (session_id, role, content, archived, ts) VALUES (?,?,?,?,?)`)
        .run('s1', 'user', '我们讨论了黑洞引擎的 FTS5 bigram 分词方案', 0, Date.now());
      db.prepare(`INSERT INTO messages (session_id, role, content, archived, ts) VALUES (?,?,?,?,?)`)
        .run('s1', 'assistant', '结论：bigram 滑窗对中文检索有效', 0, Date.now());
      const t = coreTools().memory_search!;
      const out = await t.run({ query: 'bigram 分词' }, { db } as any);
      expect(out).toContain('历史记忆命中');
      expect(out).toContain('bigram');
      const out2 = await t.run({ query: '不存在的关键词xyz' }, { db } as any);
      expect(out2).toContain('未检索到');
    } finally { closeDB(db); try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});
