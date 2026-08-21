// tests/v4-data-consistency.test.ts — V4 P3-6：数据一致性一揽子
// ① undoShadows 目录恢复按 path 分组取 ts 最大（B-1——此前落盘最旧版本）
// ② audit 哈希链原子追加（B-5 单语句 INSERT...SELECT）+ verifyAudit 篡改检测
// ③ 授权状态机（B-6——commit 后不可再 release：双退封死）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotFile, restoreDirShadows } from '../src/kernel/undoShadows.js';
import { appendAudit, verifyAudit } from '../src/kernel/audit.js';
import { openDB, closeDB } from '../src/store/db.js';

const work = (name: string) => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', `wx-${name}-`));
};

describe('V4 P3-6 数据一致性', () => {
  it('B-1：目录恢复取每文件 ts 最大版本（两份快照——恢复后为新内容）', async () => {
    const d = work('b1');
    try {
      const f = join(d, 'proj', 'a.txt');
      snapshotFile(d, f, '旧内容');
      await new Promise(r => setTimeout(r, 25)); // ts 单调可分辨
      snapshotFile(d, f, '新内容');
      const r = restoreDirShadows(d, join(d, 'proj'));
      expect(r.ok).toBe(1);
      expect(readFileSync(f, 'utf8')).toBe('新内容'); // 最新版本（非最旧——B-1 修复断言）
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });

  it('B-5：audit 链多写后校验通过（原子链尾）；verifyAudit 检出篡改', () => {
    const d = work('b5');
    const db = openDB(d);
    try {
      for (let i = 0; i < 10; i++) appendAudit(db, 'test.event', { i });
      const v = verifyAudit(db);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.count).toBeGreaterThanOrEqual(10);
      db.prepare(`UPDATE audit SET payload='{"tampered":1}' WHERE id=3`).run();
      const broken = verifyAudit(db);
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.brokenAtId).toBe(3);
    } finally { closeDB(db); try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });

  it('B-6：授权状态机——commit 后 release 被拒（APPROVAL_REPLAYED——双退封死）', async () => {
    const { installSecuritySchema, SqliteAuthorizationUnitOfWork } = await import('../src/infrastructure/sqlite/authorizationUnitOfWork.js');
    const { SqlitePolicyRepository } = await import('../src/infrastructure/sqlite/policyRepository.js');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      installSecuritySchema(db);
      const uow = new SqliteAuthorizationUnitOfWork(db, new SqlitePolicyRepository(db));
      db.prepare(`INSERT INTO approval_grants VALUES(?,?,?,?,?,?,?)`)
        .run('resv-1', 'ctxh', '{}', 'effh', 'nonce-1', '2099-01-01T00:00:00Z', 'consumed');
      db.prepare(`INSERT INTO budget_snapshots VALUES(?,?,?,1)`).run('budget-1', '{}', '{}');
      const c = uow.commit('resv-1', { x: 1 }, '2026-01-01T00:00:00Z');
      expect(c.ok).toBe(true);
      const r = uow.release('resv-1', { x: 1 }, '2026-01-01T00:00:00Z');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('APPROVAL_REPLAYED');
    } finally { db.close(); }
  });
});
