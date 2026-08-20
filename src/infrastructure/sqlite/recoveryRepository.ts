// src/infrastructure/sqlite/recoveryRepository.ts — W2-10：RecoveryCheckpoint/RecoveryDecision 精确持久化 + lease CAS orphaned
import type Database from 'better-sqlite3';
import type { RecoveryCheckpoint, RecoveryDecision } from '../../domain/autonomy/autonomyRecords.js';

export class RecoveryRepository {
  constructor(private readonly db: InstanceType<typeof Database>) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_checkpoints(run_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_decisions(run_id TEXT PRIMARY KEY, decision TEXT NOT NULL, decided_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_attempt_leases(run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY(run_id, attempt_id));
    `);
  }

  saveCheckpoint(checkpoint: RecoveryCheckpoint): void {
    this.db.prepare('INSERT INTO recovery_checkpoints VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body')
      .run(checkpoint.runId, JSON.stringify(checkpoint));
  }

  loadCheckpoint(runId: string): RecoveryCheckpoint | undefined {
    const row = this.db.prepare('SELECT body FROM recovery_checkpoints WHERE run_id=?').get(runId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as RecoveryCheckpoint : undefined;
  }

  saveDecision(runId: string, decision: RecoveryDecision): void {
    this.db.prepare('INSERT INTO recovery_decisions VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET decision=excluded.decision, decided_at=excluded.decided_at')
      .run(runId, decision, new Date().toISOString());
  }

  loadDecision(runId: string): RecoveryDecision | undefined {
    const row = this.db.prepare('SELECT decision FROM recovery_decisions WHERE run_id=?').get(runId) as { decision: string } | undefined;
    return row?.decision as RecoveryDecision | undefined;
  }

  upsertLease(runId: string, attemptId: string, leaseStatus: 'active' | 'orphaned'): void {
    this.db.prepare('INSERT INTO recovery_attempt_leases VALUES(?,?,?) ON CONFLICT(run_id, attempt_id) DO UPDATE SET lease_status=excluded.lease_status')
      .run(runId, attemptId, leaseStatus);
  }

  /** CAS：仅当 lease 仍 active 时置 orphaned——恢复与续租的竞态窗口 fail closed */
  markOrphaned(runId: string, attemptId: string): boolean {
    const result = this.db.prepare(`UPDATE recovery_attempt_leases SET lease_status='orphaned'
      WHERE run_id=? AND attempt_id=? AND lease_status='active'`).run(runId, attemptId);
    return result.changes === 1;
  }

  leaseStatus(runId: string, attemptId: string): string | undefined {
    const row = this.db.prepare('SELECT lease_status FROM recovery_attempt_leases WHERE run_id=? AND attempt_id=?').get(runId, attemptId) as { lease_status: string } | undefined;
    return row?.lease_status;
  }
}
