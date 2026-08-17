// src/migrations/db/registry.ts — DB 迁移注册表（V2 salience / V3 run_no / V4 parts / V5 安全控制面，forward-only）
import Database from 'better-sqlite3';
import { computeMigrationDescriptorChecksum } from '../types.js';
import type { MigrationDescriptor } from '../types.js';
import { securityControlPlaneMigration } from '../../infrastructure/sqlite/securityMigrations.js';
import { marketMigration } from '../../infrastructure/sqlite/marketMigrations.js';

export interface ConfirmedDbWrite {
  table: string;
  primaryKey: string;
  payloadHash: string;
}

export type DbMigration = MigrationDescriptor<
  InstanceType<typeof Database>,
  ConfirmedDbWrite,
  { reconciledRows: number; mismatches: number },
  { mode: 'restore-backup' | 'forward-fix'; recoveredRows: number }
>;

function columnExists(db: InstanceType<typeof Database>, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

interface ColumnMigrationSpec {
  id: string;
  fromVersion: number;
  toVersion: number;
  column: string;
  ddl: string;
  nullable: boolean;
  /** 目标表（默认 messages；usage_stats 等其它表可覆盖——audit §13.43） */
  table?: string;
}

function makeColumnMigration(spec: ColumnMigrationSpec): DbMigration {
  const table = spec.table ?? 'messages';
  const base = {
    id: spec.id,
    fromVersion: spec.fromVersion,
    toVersion: spec.toVersion,
    strategy: 'forward-only' as const,
    behaviorVersion: '1',
    maxRtoMs: 60_000,
    validate(db: InstanceType<typeof Database>): void {
      const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table);
      if (!tables) throw new Error(`DB_MIGRATION_MISSING_TABLE:${spec.id}:${table}`);
    },
    expand(db: InstanceType<typeof Database>): void {
      // 幂等：列已存在（新库建表已含）则跳过——同时仍记录 applied（状态已到目标）
      if (!columnExists(db, table, spec.column)) db.exec(spec.ddl);
    },
    contract(): void {
      // forward-only：不收缩（SQLite 无法安全删除列；N-1 读者窗口关闭在 GA 后由清理任务处理）
    },
    nMinusOneWindow: {
      minReaderVersion: String(spec.fromVersion),
      minWriterVersion: String(spec.fromVersion),
      closeCondition: 'GA after Gate C-W0 drill passes',
    },
    reconcile(db: InstanceType<typeof Database>) {
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      const nonNull = spec.nullable
        ? 0
        : (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${spec.column} IS NOT NULL`).get() as { c: number }).c;
      return { reconciledRows: total, mismatches: spec.nullable ? 0 : total - nonNull };
    },
    recovery(): { mode: 'forward-fix'; recoveredRows: number } {
      // 故障恢复：本 Wave 由 runner 在 backup 校验后重新执行 expand（forward-fix）
      return { mode: 'forward-fix', recoveredRows: 0 };
    },
  };
  const descriptor = {
    ...base,
    checksum: computeMigrationDescriptorChecksum(base as unknown as MigrationDescriptor<unknown>),
  } as DbMigration;
  return descriptor;
}

export function dbMigrations(): DbMigration[] {
  return [
    makeColumnMigration({
      id: 'db-v2-add-salience',
      fromVersion: 1,
      toVersion: 2,
      column: 'salience',
      ddl: 'ALTER TABLE messages ADD COLUMN salience REAL NOT NULL DEFAULT 1.0',
      nullable: false,
    }),
    makeColumnMigration({
      id: 'db-v3-add-run_no',
      fromVersion: 2,
      toVersion: 3,
      column: 'run_no',
      ddl: 'ALTER TABLE messages ADD COLUMN run_no INTEGER NOT NULL DEFAULT 0',
      nullable: false,
    }),
    makeColumnMigration({
      id: 'db-v4-add-parts',
      fromVersion: 3,
      toVersion: 4,
      column: 'parts',
      ddl: 'ALTER TABLE messages ADD COLUMN parts TEXT',
      nullable: true,
    }),
    securityControlPlaneMigration(),
    marketMigration(),
    makeColumnMigration({
      id: 'db-v7-add-usage-cache-hit',
      fromVersion: 6,
      toVersion: 7,
      table: 'usage_stats',
      column: 'cache_hit_tokens',
      ddl: 'ALTER TABLE usage_stats ADD COLUMN cache_hit_tokens INTEGER NOT NULL DEFAULT 0',
      nullable: false,
    }),
    makeColumnMigration({
      id: 'db-v8-add-usage-cache-miss',
      fromVersion: 7,
      toVersion: 8,
      table: 'usage_stats',
      column: 'cache_miss_tokens',
      ddl: 'ALTER TABLE usage_stats ADD COLUMN cache_miss_tokens INTEGER NOT NULL DEFAULT 0',
      nullable: false,
    }),
    makeColumnMigration({
      id: 'db-v9-add-session-lineage',
      fromVersion: 8,
      toVersion: 9,
      table: 'sessions',
      column: 'forked_from_id',
      ddl: 'ALTER TABLE sessions ADD COLUMN forked_from_id TEXT',
      nullable: true,
    }),
  ];
}

export function dbMigrationsFromVersion(fromVersion: number): DbMigration[] {
  return dbMigrations().filter(migration => migration.fromVersion >= fromVersion);
}
