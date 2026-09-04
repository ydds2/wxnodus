// src/migrations/db/runner.ts — DB 迁移执行器：checksum 验证 → 备份 → 事务内 expand → 版本提升 → 失败记录
import Database from 'better-sqlite3';
import { verifyMigrationDescriptorChecksum } from '../types.js';
import type { DbMigration } from './registry.js';
import { dbMigrations } from './registry.js';
import { createDbBackup, type DbBackup } from './backup.js';
import { ensureMigrationHistory, recordMigrationStarted, recordMigrationFinished, recordMigrationFailed } from './history.js';

export function getSchemaVersion(db: InstanceType<typeof Database>): number {
  ensureMigrationHistory(db);
  const row = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 1;
}

export function setSchemaVersion(db: InstanceType<typeof Database>, version: number): void {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES('schema_version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(version));
}

export interface DbMigrationOutcome {
  status: 'applied';
  backup: DbBackup;
}

/** 单次迁移：checksum 不匹配 fail-closed；事务失败 → history=failed 且版本不提升 */
export function runDbMigration(db: InstanceType<typeof Database>, dbPath: string, migration: DbMigration): DbMigrationOutcome {
  if (!verifyMigrationDescriptorChecksum(migration)) {
    throw Object.assign(new Error(`DB_MIGRATION_CHECKSUM_MISMATCH:${migration.id}`), {
      code: 'DB_MIGRATION_CHECKSUM_MISMATCH',
    });
  }
  ensureMigrationHistory(db);
  const backup = createDbBackup(db, dbPath, migration.id);
  recordMigrationStarted(db, migration, backup);

  try {
    db.transaction(() => {
      if (migration.strategy === 'rollbackable') migration.upgrade(db);
      else migration.expand(db);
      migration.validate(db);
      setSchemaVersion(db, migration.toVersion);
      recordMigrationFinished(db, migration.id, 'applied');
    })();
    return { status: 'applied', backup };
  } catch (error) {
    // 事务已回滚（schema work + 版本提升同生共死）；failed 记录在独立语句中持久化
    recordMigrationFailed(db, migration.id, 'DB_MIGRATION_FAILED');
    throw Object.assign(new Error(`DB_MIGRATION_FAILED:${migration.id}`, { cause: error }), {
      code: 'DB_MIGRATION_FAILED',
    });
  }
}

/** 按注册表顺序把 DB 升到 targetVersion（幂等：已到目标版本跳过） */
export function runDbMigrationsTo(
  db: InstanceType<typeof Database>,
  dbPath: string,
  targetVersion: number,
): DbMigrationOutcome[] {
  const outcomes: DbMigrationOutcome[] = [];
  let current = getSchemaVersion(db);
  if (current < 1) current = 1;
  for (const migration of dbMigrations()) {
    if (migration.toVersion > targetVersion) continue;
    if (migration.toVersion <= current) continue;
    outcomes.push(runDbMigration(db, dbPath, migration));
    current = migration.toVersion;
  }
  return outcomes;
}
