// tests/db-backup-recovery.test.ts — W0-06 WAL 一致备份、校验/篡改拒绝、forward-only drill
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDB, openDB } from '../src/store/db.js';
import { dbMigrations, type DbMigration } from '../src/migrations/db/registry.js';
import {
  runDbMigration,
  runDbMigrationsTo,
  getSchemaVersion,
} from '../src/migrations/db/runner.js';
import {
  createDbBackup,
  verifyDbBackup,
  verifyBackupIntegrity,
  restoreDbFromBackup,
} from '../src/migrations/db/backup.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 最小 V1 库：messages 无 salience/run_no/parts（模拟旧库） */
const V1_MESSAGES_SQL = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL,
    tool_call_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings (key, value) VALUES ('schema_version', '1');
`;

describe('DB migration backup and recovery', () => {
  it('WAL 场景备份可读：backup → 校验 → integrity → 恢复读回', () => {
    const dir = tempDir('wxn-db-backup-');
    const dbPath = join(dir, 'nodus.db');
    const db = openDB(dir);
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', '会话', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('s1', 'user', 'WAL 写', 2)`).run();
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); // 二次确保 WAL 可折叠

    const backup = createDbBackup(db, dbPath, 'drill-test');
    expect(verifyDbBackup(backup)).toEqual({ ok: true });
    expect(verifyBackupIntegrity(backup)).toEqual({ ok: true });

    const probe = new Database(backup.path, { readonly: true });
    const row = probe.prepare("SELECT content FROM messages WHERE session_id='s1'").get() as { content: string };
    expect(row.content).toBe('WAL 写');
    probe.close();
    closeDB(db);
  });

  it('备份篡改 → DB_BACKUP_CHECKSUM_MISMATCH，恢复被拒绝', () => {
    const dir = tempDir('wxn-db-tamper-');
    const dbPath = join(dir, 'nodus.db');
    const db = openDB(dir);
    const backup = createDbBackup(db, dbPath, 'tamper-test');
    closeDB(db);

    // 篡改备份文件内容（保持同样长度以便真正改变字节）
    const bytes = readFileSync(backup.path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(backup.path, bytes);

    expect(verifyDbBackup(backup)).toEqual({ ok: false, code: 'DB_BACKUP_CHECKSUM_MISMATCH' });
    const restore = restoreDbFromBackup(dbPath, backup);
    expect(restore.ok).toBe(false);
    if (restore.ok) throw new Error('EXPECTED_BACKUP_RESTORE_REFUSAL');
  });

  it('checksum drift → DB_MIGRATION_CHECKSUM_MISMATCH 且版本不提升', () => {
    const dir = tempDir('wxn-db-drift-');
    const seed = new Database(join(dir, 'nodus.db'));
    seed.exec(V1_MESSAGES_SQL);
    seed.close();

    const db = openDB(dir); // 注：openDB 会先跑完注册表迁移
    closeDB(db);

    const driftDb = new Database(join(dir, 'nodus.db'));
    const migration = dbMigrations()[0]!;
    const tampered: DbMigration = { ...migration, maxRtoMs: migration.maxRtoMs + 1 };
    let code: string | undefined;
    const before = getSchemaVersion(driftDb);
    try {
      runDbMigration(driftDb, join(dir, 'nodus.db'), tampered);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('DB_MIGRATION_CHECKSUM_MISMATCH');
    expect(getSchemaVersion(driftDb)).toBe(before);
    driftDb.close();
  });

  it('forward-only drill：expand → N-1 读写窗口 → confirmed write → reconcile → 恢复读回', () => {
    const dir = tempDir('wxn-db-drill-');
    const dbPath = join(dir, 'nodus.db');
    const seed = new Database(dbPath);
    seed.exec(V1_MESSAGES_SQL);
    seed.close();

    const db = new Database(dbPath);
    const start = Date.now();

    // expand：按注册表顺序执行 V2/V3/V4（N-1 读者/写者窗口在 expand 前保持旧列可用）
    const outcomes = runDbMigrationsTo(db, dbPath, 4);
    expect(outcomes).toHaveLength(3);

    // N-1 窗口：旧形状写入仍然成立（新列有 DEFAULT）
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s2', '窗口', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('s2', 'user', '旧形状写入', 1)`).run();

    // confirmed write：新列可写
    db.prepare(`INSERT INTO messages (session_id, role, content, ts, salience, run_no, parts) VALUES ('s2', 'assistant', '新形状', 2, 2.0, 1, '["text"]')`).run();

    // reconcile：总数一致、非空列完整
    for (const migration of dbMigrations()) {
      if (migration.strategy === 'forward-only') {
        const result = migration.reconcile(db);
        expect(result.reconciledRows).toBe(2);
        expect(result.mismatches).toBe(0);
      }
    }

    expect(getSchemaVersion(db)).toBe(4);
    expect(Date.now() - start).toBeLessThan(60_000);

    const rows = db.prepare(`SELECT content FROM messages ORDER BY ts`).all() as Array<{ content: string }>;
    expect(rows.map(r => r.content)).toEqual(['旧形状写入', '新形状']);
    db.close();
  });
});
