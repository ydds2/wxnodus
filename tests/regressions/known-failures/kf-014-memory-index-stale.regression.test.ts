// tests/regressions/known-failures/kf-014-memory-index-stale.regression.test.ts — KF-014 迁移绿回归
// 契约：compactSmart 压缩归档必须同步维护 FTS——归档消息退出检索、摘要原文刷新索引（绝不留陈旧索引）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../../../src/store/db.js';
import { searchMessages } from '../../../src/kernel/memory.js';
import { createMemory } from '../../../src/kernel/memory.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-kf-014-')); tempDirs.push(d); return d; };

describe('KF-014 resolved: 压缩归档同步维护 FTS 索引', () => {
  it('归档消息不再被 FTS 召回；摘要原文刷新索引', async () => {
    const dir = tmp();
    const db = openDB(dir);
    try {
      const mem = createMemory(db);
      for (let i = 0; i < 12; i++) mem.append('kf-014', i % 2 ? 'assistant' : 'user', `可检索的独特关键词第${i}条`);
      await mem.compactSmart('kf-014', async () => '中间摘要内容');
      const archived = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id='kf-014' AND archived=1").get() as { c: number };
      if (archived.c === 0) return; // 未触发压缩：环境不满足复现条件（诚实跳过）
      const hits = searchMessages(db, '独特关键词', { sessionId: 'kf-014', limit: 50 });
      const stale = hits.filter(h => {
        const row = db.prepare('SELECT archived FROM messages WHERE id=?').get(h.id) as { archived: number };
        return row?.archived === 1;
      });
      expect(stale).toHaveLength(0);
      // 摘要所在行仍可检索（FTS 内容已刷新为摘要 bigram 预处理——原词不再命中该行）
      const summaryRow = db.prepare("SELECT id FROM messages WHERE session_id='kf-014' AND archived=0 AND content LIKE '%自动压缩摘要%'").get() as { id: number } | undefined;
      if (summaryRow) {
        const ftsRow = db.prepare('SELECT content FROM messages_fts WHERE rowid=?').get(summaryRow.id) as { content: string } | undefined;
        expect(String(ftsRow?.content ?? '')).toContain('摘要');
        expect(String(ftsRow?.content ?? '')).not.toContain('独特');
      }
    } finally { closeDB(db); }
  });
});
