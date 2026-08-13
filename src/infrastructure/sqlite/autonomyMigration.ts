// src/infrastructure/sqlite/autonomyMigration.ts — autonomy 持久层 schema（records/budget/迁移台账）
import type Database from 'better-sqlite3';
export function migrateAutonomySchema(db: InstanceType<typeof Database>): void {
  db.transaction(() => { db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS budget_accounts(run_id TEXT PRIMARY KEY,limits_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_reservations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,dimension TEXT NOT NULL,reserved REAL NOT NULL,committed REAL NOT NULL DEFAULT 0,status TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_budget_run_dimension ON budget_reservations(run_id,dimension,status);
    CREATE TABLE IF NOT EXISTS autonomy_migrations(source_kind TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(source_kind,source_id));
  `); })();
}
