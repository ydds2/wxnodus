// src/migrations/db/history.ts — migration_history 表与 run record 持久化
import Database from 'better-sqlite3';
import type { DbMigration } from './registry.js';
import type { DbBackup } from './backup.js';

export function ensureMigrationHistory(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_history (
      id TEXT PRIMARY KEY,
      from_version INTEGER NOT NULL,
      to_version INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      applied_at TEXT,
      error_code TEXT,
      backup_path TEXT,
      backup_sha256 TEXT
    )
  `);
}

export function recordMigrationStarted(db: InstanceType<typeof Database>, migration: DbMigration, backup: DbBackup): void {
  ensureMigrationHistory(db);
  db.prepare(
    `INSERT OR REPLACE INTO migration_history
      (id, from_version, to_version, checksum, strategy, status, started_at, backup_path, backup_sha256)
     VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?)`,
  ).run(
    migration.id,
    migration.fromVersion,
    migration.toVersion,
    migration.checksum,
    migration.strategy,
    new Date().toISOString(),
    backup.path,
    backup.sha256,
  );
}

/** 事务内调用：applied 与迁移事务同生共死（失败随事务回滚，由 runDbMigration 单独写 failed） */
export function recordMigrationFinished(
  db: InstanceType<typeof Database>,
  migrationId: string,
  status: 'applied',
): void {
  db.prepare(
    `UPDATE migration_history SET status=?, applied_at=? WHERE id=? AND status='started'`,
  ).run(status, new Date().toISOString(), migrationId);
}

/** 事务外调用：迁移失败时把 started 行改写成 failed（不回滚） */
export function recordMigrationFailed(
  db: InstanceType<typeof Database>,
  migrationId: string,
  errorCode: string,
): void {
  ensureMigrationHistory(db);
  db.prepare(
    `UPDATE migration_history SET status='failed', error_code=? WHERE id=?`,
  ).run(errorCode, migrationId);
}
