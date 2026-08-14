// src/infrastructure/sqlite/authorizationUnitOfWork.ts — 授权事务单元：issue/consume 同事务，journal 哈希链
import type Database from 'better-sqlite3';
import type { OperationResult } from '../../protocol/results.js';
import type { GatewayError } from '../../protocol/errors.js';
import { authorizationContextHash, sha256Canonical, type ApprovalGrant, type AuthorizationContext } from '../../domain/security/approvalGrant.js';
import { decideEffect } from '../../domain/security/pdp.js';
import { SqlitePolicyRepository } from './policyRepository.js';

type Budget = Record<string, number>;
type Code = 'POLICY_UNAVAILABLE'|'POLICY_DENIED'|'APPROVAL_CONTEXT_MISMATCH'|'APPROVAL_EXPIRED'|'APPROVAL_REVOKED'|'APPROVAL_REPLAYED'|'POLICY_CHANGED'|'BUDGET_SNAPSHOT_CHANGED'|'BUDGET_EXCEEDED'|'EFFECT_JOURNAL_INTEGRITY_FAILED';
const fail = (code: Code): { ok: false; error: GatewayError } => ({ ok: false, error: { code, message: code, messageKey: code, retryable: false } });
class Rollback extends Error { constructor(readonly result: { ok: false; error: GatewayError }) { super(result.error.code); } }
const value = <T>(result: OperationResult<T>): T => { if (!result.ok) throw new Rollback(result); return result.value; };

export function installSecuritySchema(db: Database.Database): void { db.exec(`
  CREATE TABLE IF NOT EXISTS policy_snapshots(id TEXT PRIMARY KEY,document_json TEXT NOT NULL,checksum TEXT NOT NULL,active INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS policy_one_active ON policy_snapshots(active) WHERE active=1;
  CREATE TABLE IF NOT EXISTS budget_snapshots(id TEXT PRIMARY KEY,limits_json TEXT NOT NULL,used_json TEXT NOT NULL,active INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS budget_one_active ON budget_snapshots(active) WHERE active=1;
  CREATE TABLE IF NOT EXISTS approval_grants(id TEXT PRIMARY KEY,context_hash TEXT NOT NULL UNIQUE,context_json TEXT NOT NULL,effect_hash TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS effect_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT,effect_id TEXT NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,prev_hash TEXT NOT NULL,entry_hash TEXT NOT NULL,created_at TEXT NOT NULL);
`); }

export class SqliteAuthorizationUnitOfWork {
  constructor(private readonly db: Database.Database, private readonly policies: SqlitePolicyRepository) {}
  issue(input: { id: string; context: AuthorizationContext; nonce: string; expiresAt: string; now: string }): OperationResult<ApprovalGrant> {
    try { return this.db.transaction(() => {
      const policy = value(this.policies.loadActive());
      if (policy.id !== input.context.policySnapshotId) throw new Rollback(fail('POLICY_CHANGED'));
      const budget = this.db.prepare('SELECT id FROM budget_snapshots WHERE active=1').get() as { id: string } | undefined;
      if (!budget || budget.id !== input.context.budgetSnapshotId) throw new Rollback(fail('BUDGET_SNAPSHOT_CHANGED'));
      if (decideEffect(policy.document, input.context.effect.kind) === 'deny') throw new Rollback(fail('POLICY_DENIED'));
      if (input.expiresAt <= input.now) throw new Rollback(fail('APPROVAL_EXPIRED'));
      const grant: ApprovalGrant = { id: input.id, actorId: input.context.actorId, sessionId: input.context.sessionId, runId: input.context.runId, toolId: input.context.toolId, argsHash: input.context.argsHash, effectHash: sha256Canonical(input.context.effect), resourceHash: input.context.resourceHash, policySnapshotId: input.context.policySnapshotId, budgetSnapshotId: input.context.budgetSnapshotId, authorizationContextHash: authorizationContextHash(input.context), nonce: input.nonce, expiresAt: input.expiresAt, status: 'issued' };
      this.db.prepare("INSERT INTO approval_grants VALUES(?,?,?,?,?,?, 'issued')").run(grant.id, grant.authorizationContextHash, JSON.stringify(input.context), grant.effectHash, grant.nonce, grant.expiresAt);
      return { ok: true as const, value: grant };
    })(); } catch (error) { return error instanceof Rollback ? error.result : fail('POLICY_UNAVAILABLE'); }
  }
  consumeAndReserve(input: { grantId: string; context: AuthorizationContext; reservation: Budget; now: string }): OperationResult<{ reservationId: string }> {
    try { return this.db.transaction(() => {
      const grant = this.db.prepare('SELECT * FROM approval_grants WHERE id=?').get(input.grantId) as Record<string, string> | undefined;
      if (!grant || grant.context_hash !== authorizationContextHash(input.context) || grant.effect_hash !== sha256Canonical(input.context.effect)) throw new Rollback(fail('APPROVAL_CONTEXT_MISMATCH'));
      if (grant.status === 'consumed') throw new Rollback(fail('APPROVAL_REPLAYED'));
      if (grant.status === 'revoked') throw new Rollback(fail('APPROVAL_REVOKED'));
      if (grant.expires_at <= input.now) throw new Rollback(fail('APPROVAL_EXPIRED'));
      const policy = value(this.policies.loadActive());
      if (policy.id !== input.context.policySnapshotId) throw new Rollback(fail('POLICY_CHANGED'));
      if (decideEffect(policy.document, input.context.effect.kind) === 'deny') throw new Rollback(fail('POLICY_DENIED'));
      const budget = this.db.prepare('SELECT id,limits_json,used_json FROM budget_snapshots WHERE active=1').get() as { id: string; limits_json: string; used_json: string } | undefined;
      if (!budget || budget.id !== input.context.budgetSnapshotId) throw new Rollback(fail('BUDGET_SNAPSHOT_CHANGED'));
      const limits = JSON.parse(budget.limits_json) as Budget, used = JSON.parse(budget.used_json) as Budget;
      for (const [key, amount] of Object.entries(input.reservation)) if ((used[key] ?? 0) + amount > (limits[key] ?? 0)) throw new Rollback(fail('BUDGET_EXCEEDED'));
      for (const [key, amount] of Object.entries(input.reservation)) used[key] = (used[key] ?? 0) + amount;
      if (this.db.prepare("UPDATE approval_grants SET status='consumed' WHERE id=? AND status='issued'").run(input.grantId).changes !== 1) throw new Rollback(fail('APPROVAL_REPLAYED'));
      this.db.prepare('UPDATE budget_snapshots SET used_json=? WHERE id=?').run(JSON.stringify(used), budget.id);
      this.appendJournal(input.grantId, 'reserved', { contextHash: grant.context_hash, reservation: input.reservation }, input.now);
      return { ok: true as const, value: { reservationId: input.grantId } };
    })(); } catch (error) { return error instanceof Rollback ? error.result : fail('POLICY_UNAVAILABLE'); }
  }
  verifyJournal(): OperationResult<void> {
    let previous = 'GENESIS';
    for (const row of this.db.prepare('SELECT * FROM effect_journal ORDER BY sequence').all() as Array<Record<string, string | number>>) {
      const expected = sha256Canonical({ sequence: row.sequence, effectId: row.effect_id, state: row.state, payloadJson: row.payload_json, previous, createdAt: row.created_at });
      if (row.prev_hash !== previous || row.entry_hash !== expected) return fail('EFFECT_JOURNAL_INTEGRITY_FAILED');
      previous = String(row.entry_hash);
    }
    return { ok: true, value: undefined };
  }
  /** 活动预算快照 id（pipeline authorize 上下文绑定用；无活动快照 → BUDGET_SNAPSHOT_CHANGED 语义 fail） */
  activeBudgetSnapshotId(): OperationResult<string> {
    try {
      const budget = this.db.prepare('SELECT id FROM budget_snapshots WHERE active=1').get() as { id: string } | undefined;
      return budget ? { ok: true, value: budget.id } : { ok: false, error: { code: 'BUDGET_SNAPSHOT_CHANGED', message: 'BUDGET_SNAPSHOT_CHANGED', messageKey: 'BUDGET_SNAPSHOT_CHANGED', retryable: false } };
    } catch { return { ok: false, error: { code: 'BUDGET_SNAPSHOT_CHANGED', message: 'BUDGET_SNAPSHOT_CHANGED', messageKey: 'BUDGET_SNAPSHOT_CHANGED', retryable: false } }; }
  }
  /** W1-08：pipeline 生命周期 journal 状态追加（applied/failed/cancelled/committed/released）——哈希链单一事实 */
  appendJournalEntry(effectId: string, state: string, payload: unknown, createdAt: string): OperationResult<void> {
    try {
      this.db.transaction(() => { this.appendJournal(effectId, state, payload, createdAt); })();
      return { ok: true, value: undefined };
    } catch { return fail('POLICY_UNAVAILABLE'); }
  }
  /** W1-08：commit——预算已在 reserve 扣除；commit 只落链（committed） */
  commit(reservationId: string, value: unknown, createdAt: string): OperationResult<void> {
    try {
      this.db.transaction(() => {
        const grant = this.db.prepare(`SELECT status FROM approval_grants WHERE id=?`).get(reservationId) as { status: string } | undefined;
        if (!grant || grant.status !== 'consumed') throw new Rollback(fail('APPROVAL_REPLAYED'));
        this.appendJournal(reservationId, 'committed', { value }, createdAt);
      })();
      return { ok: true, value: undefined };
    } catch (error) { return error instanceof Rollback ? error.result : fail('POLICY_UNAVAILABLE'); }
  }
  /** W1-08：release——执行失败/取消后退还预算（used 回减）并落链（released） */
  release(reservationId: string, reservation: Budget, createdAt: string): OperationResult<void> {
    try {
      this.db.transaction(() => {
        const grant = this.db.prepare(`SELECT status FROM approval_grants WHERE id=?`).get(reservationId) as { status: string } | undefined;
        if (!grant || grant.status !== 'consumed') throw new Rollback(fail('APPROVAL_REPLAYED'));
        const budget = this.db.prepare('SELECT id,used_json FROM budget_snapshots WHERE active=1').get() as { id: string; used_json: string } | undefined;
        if (!budget) throw new Rollback(fail('BUDGET_SNAPSHOT_CHANGED'));
        const used = JSON.parse(budget.used_json) as Budget;
        for (const [key, amount] of Object.entries(reservation)) used[key] = Math.max(0, (used[key] ?? 0) - amount);
        this.db.prepare('UPDATE budget_snapshots SET used_json=? WHERE id=?').run(JSON.stringify(used), budget.id);
        this.appendJournal(reservationId, 'released', { reservation }, createdAt);
      })();
      return { ok: true, value: undefined };
    } catch (error) { return error instanceof Rollback ? error.result : fail('POLICY_UNAVAILABLE'); }
  }
  private appendJournal(effectId: string, state: string, payload: unknown, createdAt: string): void {
    const tail = this.db.prepare('SELECT sequence,entry_hash FROM effect_journal ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; entry_hash: string } | undefined;
    const previous = tail?.entry_hash ?? 'GENESIS', sequence = (tail?.sequence ?? 0) + 1, payloadJson = JSON.stringify(payload);
    const entryHash = sha256Canonical({ sequence, effectId, state, payloadJson, previous, createdAt });
    this.db.prepare('INSERT INTO effect_journal VALUES(?,?,?,?,?,?,?)').run(sequence, effectId, state, payloadJson, previous, entryHash, createdAt);
  }
}
