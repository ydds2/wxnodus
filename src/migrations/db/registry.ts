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

function serveSessionOwnershipMigration(): DbMigration {
  const base = {
    id: 'db-v11-add-serve-session-ownership',
    fromVersion: 10,
    toVersion: 11,
    strategy: 'forward-only' as const,
    behaviorVersion: '1',
    maxRtoMs: 60_000,
    validate(db: InstanceType<typeof Database>): void {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='serve_session_ownership'").get();
      const updateTrigger = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='serve_session_ownership_immutable'").get();
      const deleteTrigger = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='serve_session_ownership_delete_denied'").get();
      if (!table || !updateTrigger || !deleteTrigger) throw new Error('DB_MIGRATION_MISSING_TABLE:db-v11-add-serve-session-ownership');
    },
    expand(db: InstanceType<typeof Database>): void {
      installServeSessionOwnershipSchema(db);
    },
    contract(): void {
      // Additive ownership metadata remains readable by V10 clients, which ignore it.
    },
    nMinusOneWindow: {
      minReaderVersion: '10',
      minWriterVersion: '10',
      closeCondition: 'GA after P0-5 serve isolation tests pass',
    },
    reconcile(db: InstanceType<typeof Database>) {
      const total = (db.prepare('SELECT COUNT(*) AS c FROM serve_session_ownership').get() as { c: number }).c;
      const invalid = (db.prepare("SELECT COUNT(*) AS c FROM serve_session_ownership WHERE principal_id='' OR session_id='' ").get() as { c: number }).c;
      return { reconciledRows: total, mismatches: invalid };
    },
    recovery(): { mode: 'forward-fix'; recoveredRows: number } {
      return { mode: 'forward-fix', recoveredRows: 0 };
    },
  };
  return { ...base, checksum: computeMigrationDescriptorChecksum(base as unknown as MigrationDescriptor<unknown>) } as DbMigration;
}

export function installServeSessionOwnershipSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS serve_session_ownership (
      session_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      claimed_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_serve_principal_default
      ON serve_session_ownership(principal_id) WHERE is_default = 1;
    CREATE TRIGGER IF NOT EXISTS serve_session_ownership_immutable
      BEFORE UPDATE OF session_id, principal_id, claimed_at ON serve_session_ownership
      WHEN NEW.session_id != OLD.session_id
        OR NEW.principal_id != OLD.principal_id
        OR NEW.claimed_at != OLD.claimed_at
      BEGIN
        SELECT RAISE(ABORT, 'SERVE_SESSION_OWNERSHIP_IMMUTABLE');
      END;
    CREATE TRIGGER IF NOT EXISTS serve_session_ownership_delete_denied
      BEFORE DELETE ON serve_session_ownership
      BEGIN
        SELECT RAISE(ABORT, 'SERVE_SESSION_OWNERSHIP_DELETE_DENIED');
      END;
  `);
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
    makeColumnMigration({
      id: 'db-v10-add-usage-reasoning',
      fromVersion: 9,
      toVersion: 10,
      table: 'usage_stats',
      column: 'reasoning_tokens',
      ddl: 'ALTER TABLE usage_stats ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0',
      nullable: false,
    }),
    serveSessionOwnershipMigration(),
    durablePromptsMigration(),
  ];
}

/** P2-14（2026-08-27）：用户消息持久队列（db-v12——codex durable queue 机制对齐·实现原创） */
function durablePromptsMigration(): DbMigration {
  const base = {
    id: 'db-v12-add-durable-prompts',
    fromVersion: 11,
    toVersion: 12,
    strategy: 'forward-only' as const,
    behaviorVersion: '1',
    maxRtoMs: 60_000,
    validate(db: InstanceType<typeof Database>): void {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_prompts'").get();
      if (!table) throw new Error('DB_MIGRATION_MISSING_TABLE:db-v12-add-durable-prompts');
    },
    expand(db: InstanceType<typeof Database>): void {
      installDurablePromptsSchema(db);
    },
    contract(): void {
      // 纯新增表：V11 客户端忽略（队列仅本版本消费）
    },
    nMinusOneWindow: {
      minReaderVersion: '11',
      minWriterVersion: '11',
      closeCondition: 'GA after P2-14 durable queue tests pass',
    },
    reconcile(db: InstanceType<typeof Database>) {
      const total = (db.prepare('SELECT COUNT(*) AS c FROM durable_prompts').get() as { c: number }).c;
      const invalid = (db.prepare("SELECT COUNT(*) AS c FROM durable_prompts WHERE status NOT IN ('queued','running','done','interrupted')").get() as { c: number }).c;
      return { reconciledRows: total, mismatches: invalid };
    },
    recovery(): { mode: 'forward-fix'; recoveredRows: number } {
      return { mode: 'forward-fix', recoveredRows: 0 };
    },
  };
  return { ...base, checksum: computeMigrationDescriptorChecksum(base as unknown as MigrationDescriptor<unknown>) } as DbMigration;
}

export function installDurablePromptsSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','interrupted')),
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_durable_session_status ON durable_prompts(session_id, status);
  `);
}

export function dbMigrationsFromVersion(fromVersion: number): DbMigration[] {
  return dbMigrations().filter(migration => migration.fromVersion >= fromVersion);
}
