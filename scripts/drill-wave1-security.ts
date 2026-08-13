// scripts/drill-wave1-security.ts — Wave 1 安全控制面 forward-only drill（4→5）：真实 UoW 授权 + journal 链校验
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbMigrations } from '../src/migrations/db/registry.js';
import { runDbMigrationsTo, getSchemaVersion } from '../src/migrations/db/runner.js';
import { SqliteAuthorizationUnitOfWork } from '../src/infrastructure/sqlite/authorizationUnitOfWork.js';
import { SqlitePolicyRepository } from '../src/infrastructure/sqlite/policyRepository.js';
import { sha256Canonical } from '../src/domain/security/approvalGrant.js';
import type { EffectDescriptor } from '../src/domain/effects/effectDescriptor.js';
import type { ToolId } from '../src/domain/tools/toolIds.js';

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

const dir = mkdtempSync(join(tmpdir(), 'wxn-drill-w1-'));
const dbPath = join(dir, 'nodus.db');
try {
  const seed = new Database(dbPath);
  seed.exec(V1_MESSAGES_SQL);
  seed.close();

  const db = new Database(dbPath);
  const migration = dbMigrations().find(m => m.id === 'db-v5-add-security-control-plane');
  if (!migration || migration.strategy !== 'forward-only') throw new Error('W1_SECURITY_MIGRATION_MISSING');

  // upgrade（expand）+ 新版本确认写入（V2-V5 全链）
  const outcomes = runDbMigrationsTo(db, dbPath, 5);
  if (outcomes.length !== 4) throw new Error('W1_EXPAND_COUNT_MISMATCH');

  // confirmed new write：真实授权 UoW——policy/budget snapshot + issue + consume + journal
  const policyDoc = { version: 1, hardRedlineKinds: ['process.spawn'], rules: [{ effectKind: 'filesystem.write', action: 'require_approval' }] };
  db.prepare('INSERT INTO policy_snapshots VALUES(?,?,?,1)').run('policy-w1', JSON.stringify(policyDoc), sha256Canonical(policyDoc));
  db.prepare('INSERT INTO budget_snapshots VALUES(?,?,?,1)').run('budget-w1', JSON.stringify({ externalWrites: 1 }), JSON.stringify({ externalWrites: 0 }));
  const uow = new SqliteAuthorizationUnitOfWork(db, new SqlitePolicyRepository(db));
  const effect: EffectDescriptor = { kind: 'filesystem.write', resource: 'file:///tmp/a.txt', operation: 'replace', external: false, dataClassification: 'internal', reversibility: 'reversible' };
  const context = { actorId: 'maker', sessionId: 's1', runId: 'r1', toolId: 'builtin:fs-write' as ToolId, argsHash: sha256Canonical({ path: 'a.txt' }), effect, resourceHash: sha256Canonical(effect.resource), policySnapshotId: 'policy-w1', budgetSnapshotId: 'budget-w1' };
  const issued = uow.issue({ id: 'grant-w1', context, nonce: 'nonce-w1', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' });
  if (!issued.ok) throw new Error(`W1_GRANT_ISSUE_FAILED:${issued.error.code}`);
  const consumed = uow.consumeAndReserve({ grantId: 'grant-w1', context, reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' });
  if (!consumed.ok) throw new Error(`W1_GRANT_CONSUME_FAILED:${consumed.error.code}`);

  // reconcile（grant/budget binding + journal 链）+ recovery（forward-fix）+ re-upgrade 合同
  const r = migration.reconcile(db);
  if (r.mismatches !== 0) throw new Error('W1_RECONCILE_MISMATCH');
  const rec = migration.recovery(db, new Error('drill'));
  if (rec.mode !== 'forward-fix') throw new Error('W1_RECOVERY_MODE_INVALID');
  if (!uow.verifyJournal().ok) throw new Error('W1_JOURNAL_CHAIN_BROKEN');
  if (getSchemaVersion(db) !== 5) throw new Error('W1_VERSION_NOT_RAISED');
  db.close();

  console.log('WAVE1_SECURITY_DRILL: upgrade → new-write → reconcile → journal-verify → forward-fix 通过');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 延迟解锁 */ }
}
