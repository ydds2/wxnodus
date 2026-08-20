// src/infrastructure/sqlite/marketMigrations.ts — W5-01 市场持久化迁移（forward-only additive：5→6）
// market_items（PRIMARY KEY(id,version)——同 id/version 覆盖即冲突）/ market_keys（信任根）/ market_audit（哈希链）
// / market_nonces（跨重启重放防护）。合同与 security 迁移一致：expand 无 IF NOT EXISTS（已存在即失败）。
import type Database from 'better-sqlite3';
import { computeMigrationDescriptorChecksum } from '../../migrations/types.js';
import type { MigrationDescriptor } from '../../migrations/types.js';
import { sha256Canonical } from '../../domain/security/approvalGrant.js';
import type { DbMigration } from '../../migrations/db/registry.js';

export const MARKET_TABLES = ['market_items', 'market_keys', 'market_audit', 'market_nonces'] as const;

export function installMarketSchema(db: Database.Database): void {
  db.exec(`
CREATE TABLE market_items (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  signer_key_id TEXT NOT NULL,
  expiry INTEGER,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE market_keys (
  key_id TEXT PRIMARY KEY,
  public_pem TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  authorized_by_key_id TEXT,
  authorized_by_signature TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE market_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT NOT NULL,
  nonce TEXT,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE market_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`);
}

export function marketMigration(): DbMigration {
  const base = {
    id: 'db-v6-add-market',
    fromVersion: 5,
    toVersion: 6,
    strategy: 'forward-only' as const,
    behaviorVersion: '1',
    maxRtoMs: 60_000,
    validate(db: InstanceType<typeof Database>): void {
      for (const table of MARKET_TABLES) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!row) throw new Error(`DB_MIGRATION_MISSING_TABLE:db-v6-add-market:${table}`);
      }
    },
    expand(db: InstanceType<typeof Database>): void {
      // 无 IF NOT EXISTS：表已存在则抛错 → 事务回滚 + history=failed（不冒充 applied）
      installMarketSchema(db);
    },
    contract(): void {
      // forward-only additive：N-1 读者窗口保持；contract 阶段无收缩
    },
    nMinusOneWindow: {
      minReaderVersion: '5',
      minWriterVersion: '5',
      closeCondition: 'GA after W5-01 market trust tests pass',
    },
    reconcile(db: InstanceType<typeof Database>) {
      const has = (table: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!has('market_audit')) return { reconciledRows: 0, mismatches: 0 };
      // 审计哈希链对账（GENESIS → entry_hash 连续）
      let previous = 'GENESIS';
      let rows = 0;
      let mismatches = 0;
      for (const row of db.prepare('SELECT * FROM market_audit ORDER BY sequence').all() as Array<Record<string, string | number>>) {
        rows++;
        const expected = sha256Canonical({ sequence: row.sequence, action: row.action, actor: row.actor, target: row.target, nonce: row.nonce, previous, createdAt: row.created_at });
        if (row.prev_hash !== previous || row.entry_hash !== expected) mismatches++;
        previous = String(row.entry_hash);
      }
      return { reconciledRows: rows, mismatches };
    },
    recovery(): { mode: 'forward-fix'; recoveredRows: number } {
      return { mode: 'forward-fix', recoveredRows: 0 };
    },
  };
  return { ...base, checksum: computeMigrationDescriptorChecksum(base as unknown as MigrationDescriptor<unknown>) } as DbMigration;
}
