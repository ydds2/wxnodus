// src/infrastructure/sqlite/securityMigrations.ts — Wave 1 安全控制面迁移（forward-only additive：4→5）
// 合同：expand 无 IF NOT EXISTS（已存在即失败，不得冒充 applied/checksum）；
// reconcile 校验 grant/context/budget binding 与 effect journal 哈希链；recovery 仅 forward-fix。
import type Database from 'better-sqlite3';
import { computeMigrationDescriptorChecksum } from '../../migrations/types.js';
import type { MigrationDescriptor } from '../../migrations/types.js';
import { authorizationContextHash, sha256Canonical } from '../../domain/security/approvalGrant.js';
import type { DbMigration } from '../../migrations/db/registry.js';
import { installSecuritySchema } from './authorizationUnitOfWork.js';

export function securityControlPlaneMigration(): DbMigration {
  const base = {
    id: 'db-v5-add-security-control-plane',
    fromVersion: 4,
    toVersion: 5,
    strategy: 'forward-only' as const,
    behaviorVersion: '1',
    maxRtoMs: 60_000,
    validate(db: InstanceType<typeof Database>): void {
      for (const table of ['policy_snapshots', 'budget_snapshots', 'approval_grants', 'effect_journal']) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!row) throw new Error(`DB_MIGRATION_MISSING_TABLE:db-v5-add-security-control-plane:${table}`);
      }
    },
    expand(db: InstanceType<typeof Database>): void {
      // 无 IF NOT EXISTS：表已存在则抛错 → 事务回滚 + history=failed（不冒充 applied）
      installSecuritySchema(db);
    },
    contract(): void {
      // forward-only additive：N-1 读者可忽略新表窗口保持；contract 阶段无收缩
    },
    nMinusOneWindow: {
      minReaderVersion: '4',
      minWriterVersion: '4',
      closeCondition: 'GA after Gate F W1-07 passes',
    },
    reconcile(db: InstanceType<typeof Database>) {
      const has = (table: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      // 未应用（N-1 读者窗口）：无行可对账，0 mismatch——由 runner 的版本闸保证不提前 reconcile
      if (!has('approval_grants')) return { reconciledRows: 0, mismatches: 0 };
      let mismatches = 0;
      const grants = db.prepare('SELECT context_json,context_hash,budget_snapshot_id FROM approval_grants')
        .all() as Array<{ context_json: string; context_hash: string; budget_snapshot_id: string }>;
      for (const grant of grants) {
        let context: unknown;
        try { context = JSON.parse(grant.context_json); } catch { mismatches++; continue; }
        if (authorizationContextHash(context as Parameters<typeof authorizationContextHash>[0]) !== grant.context_hash) mismatches++;
        if (!db.prepare('SELECT id FROM budget_snapshots WHERE id=?').get(grant.budget_snapshot_id)) mismatches++;
      }
      // effect journal 哈希链对账（GENESIS → entry_hash 连续）
      if (has('effect_journal')) {
        let previous = 'GENESIS';
        for (const row of db.prepare('SELECT * FROM effect_journal ORDER BY sequence').all() as Array<Record<string, string | number>>) {
          const expected = sha256Canonical({ sequence: row.sequence, effectId: row.effect_id, state: row.state, payloadJson: row.payload_json, previous, createdAt: row.created_at });
          if (row.prev_hash !== previous || row.entry_hash !== expected) mismatches++;
          previous = String(row.entry_hash);
        }
      }
      return { reconciledRows: grants.length, mismatches };
    },
    recovery(): { mode: 'forward-fix'; recoveredRows: number } {
      // 故障恢复：runner 在校验备份后重跑 expand（forward-fix）；restore-backup 由 backup 合同兜底
      return { mode: 'forward-fix', recoveredRows: 0 };
    },
  };
  return { ...base, checksum: computeMigrationDescriptorChecksum(base as unknown as MigrationDescriptor<unknown>) } as DbMigration;
}
