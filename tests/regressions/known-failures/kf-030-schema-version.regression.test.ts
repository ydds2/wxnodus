// tests/regressions/known-failures/kf-030-schema-version.regression.test.ts — KF-030 已修复回归
// W0-06 起：openDB 由 registry 驱动 V2/V3/V4 列迁移并把 schema_version 提升到 4，
// 且 migration_history 记录 applied 迁移——DB_SCHEMA_VERSION_DRIFT 缺陷不再成立。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';

describe('KF-030 resolved: schema version no longer drifts', () => {
  it('openDB 后将 schema_version 对齐到 4 并记录 migration history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf030-'));
    try {
      const db = openDB(dir);
      const row = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string };
      const history = db.prepare("SELECT COUNT(*) AS count FROM migration_history WHERE status='applied'").get() as { count: number };
      expect(Number(row.value)).toBe(4);
      expect(history.count).toBeGreaterThanOrEqual(3);
      closeDB(db);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
