// src/domain/build/buildRun.ts — 不可变验证快照：首个 verifier 前创建一次，贯穿全部 verifier/evidence/CompletionGate；
// 任何漂移 → BUILD_VERIFICATION_SNAPSHOT_MISMATCH
import type { OperationResult } from '../../protocol/results.js';

export interface BuildVerificationSnapshot {
  runId: string;
  artifactHash: string;
  verificationId: string;
  environmentSnapshotId: string;
  capabilitySnapshotId: string;
  policySnapshotId: string;
}

export function createBuildVerificationSnapshot(input: Omit<BuildVerificationSnapshot, 'verificationId'>): BuildVerificationSnapshot {
  return Object.freeze({ ...input, verificationId: `verification-${input.runId}` });
}

export function assertSnapshotMatch(
  expected: BuildVerificationSnapshot,
  actual: Partial<BuildVerificationSnapshot>,
): OperationResult<void> {
  const drift = (Object.keys(expected) as Array<keyof BuildVerificationSnapshot>)
    .filter(key => actual[key] !== undefined && actual[key] !== expected[key]);
  return drift.length === 0 ? { ok: true, value: undefined } : {
    ok: false,
    error: {
      code: 'BUILD_VERIFICATION_SNAPSHOT_MISMATCH',
      message: `verification snapshot drifted: ${drift.join(', ')}`,
      messageKey: 'BUILD_VERIFICATION_SNAPSHOT_MISMATCH',
      retryable: false,
      details: { drift },
    },
  };
}
