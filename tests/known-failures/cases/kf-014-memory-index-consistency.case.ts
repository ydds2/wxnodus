import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB, searchMessages } from '../../../src/store/db.js';
import { createMemory } from '../../../src/kernel/memory.js';

await runKnownFailureCase({
  failureId: 'KF-014',
  expectedFailureCode: 'MEMORY_INDEX_STALE',
  assertionMessage: 'MEMORY_INDEX_STALE',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-014-'));
    const db = openDB(dir);
    try {
      const mem = createMemory(db);
      for (let i = 0; i < 10; i++) mem.append('kf-014', i % 2 ? 'assistant' : 'user', '可检索的独特关键词第' + i + '条');
      await mem.compactSmart('kf-014', async () => '中间摘要');
      const hits = searchMessages(db, '独特关键词', { sessionId: 'kf-014', limit: 50 });
      const archived = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id='kf-014' AND archived=1").get() as { c: number };
      if (archived.c === 0) return; // 未触发压缩：环境不满足复现条件
      // 正确行为：已归档（压缩）消息不得再被 FTS 召回；当前 FTS 索引不随 archived 更新
      const archivedHits = hits.filter(h => db.prepare('SELECT archived FROM messages WHERE id=?').get(h.id) as { archived: number }).some(x => false);
      void archivedHits;
      const stale = hits.some(h => {
        const row = db.prepare('SELECT archived FROM messages WHERE id=?').get(h.id) as { archived: number };
        return row?.archived === 1;
      });
      assert.equal(stale, false, 'MEMORY_INDEX_STALE');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
