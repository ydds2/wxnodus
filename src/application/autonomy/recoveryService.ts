// src/application/autonomy/recoveryService.ts — W2-10：lineage recovery（lease 未过期 → RECOVERY_LEASE_ACTIVE；
// 过期先 CAS orphaned，校验 worktree/base/head/owned-file 与 evidence 后只返回三个稳定决策；
// 恢复创建新 Attempt ordinal，旧 Attempt 不改写为 completed）
import type { OperationResult } from '../../protocol/results.js';
import type { RecoveryCheckpoint, RecoveryDecision } from '../../domain/autonomy/autonomyRecords.js';
import type { RecoveryRepository } from '../../infrastructure/sqlite/recoveryRepository.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface RecoveryServicePorts {
  now(): number;
  /** worktree/base/head/owned-file 校验：返回 drift 文件列表 */
  verifyWorktree(checkpoint: RecoveryCheckpoint): Promise<string[]>;
  /** evidence 完整性校验（W1 store verify） */
  verifyEvidence(evidenceIds: string[]): Promise<boolean>;
  /** 恢复创建新 Attempt（内部取 W2-09 attempts 的下一 ordinal；旧 Attempt 状态不改写） */
  createRecoveryAttempt(runId: string): Promise<number>;
}

export interface RecoveryResult {
  decision: RecoveryDecision;
  newAttemptOrdinal: number | null;
}

export class RecoveryService {
  constructor(private readonly checkpoints: RecoveryRepository, private readonly ports: RecoveryServicePorts) {}

  async recover(runId: string): Promise<OperationResult<RecoveryResult>> {
    const checkpoint = this.checkpoints.loadCheckpoint(runId);
    if (!checkpoint) return fail('RECOVERY_CHECKPOINT_MISSING', { runId });
    // lease 未过期 → 拒绝介入（续租竞态 fail closed）
    if (Date.parse(checkpoint.leaseExpiresAt) > this.ports.now()) {
      return fail('RECOVERY_LEASE_ACTIVE', { runId, leaseExpiresAt: checkpoint.leaseExpiresAt });
    }
    // 过期 → CAS orphaned（并发恢复只允许一个赢家）
    const orphaned = this.checkpoints.markOrphaned(runId, checkpoint.attemptId);
    if (!orphaned) return fail('RECOVERY_LEASE_ACTIVE', { runId, reason: 'cas-lost' });

    const drift = await this.ports.verifyWorktree(checkpoint);
    const evidenceOk = await this.ports.verifyEvidence(checkpoint.evidenceIds);
    if (drift.length === 0 && evidenceOk) {
      const ordinal = await this.ports.createRecoveryAttempt(runId);
      this.checkpoints.saveDecision(runId, 'resume-from-checkpoint');
      return { ok: true, value: { decision: 'resume-from-checkpoint', newAttemptOrdinal: ordinal } };
    }
    if (drift.length > 0 && evidenceOk) {
      this.checkpoints.saveDecision(runId, 'reconcile-worktree');
      return { ok: true, value: { decision: 'reconcile-worktree', newAttemptOrdinal: null } };
    }
    this.checkpoints.saveDecision(runId, 'manual-review');
    return { ok: true, value: { decision: 'manual-review', newAttemptOrdinal: null } };
  }
}
