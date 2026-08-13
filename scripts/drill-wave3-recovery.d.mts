// scripts/drill-wave3-recovery.d.mts — 类型声明（实现见 drill-wave3-recovery.mjs）
export interface Wave3RecoveryDescriptor {
  id: string;
  strategy: 'rollbackable' | 'forward-only';
  hash: string;
  expectedHash?: string;
  backupHash?: string | null;
  drill(ctx: { root: string }): { ok: boolean; stage?: string; cause?: string; evidenceId?: string | null };
}
export interface Wave3RecoveryDrillOptions {
  root: string;
  runId: string;
  candidateCommit: string;
  artifactId: string;
  artifactSha256: string;
  environmentSnapshotId: string;
  descriptors: Wave3RecoveryDescriptor[];
  maxRtoMs?: number;
}
export interface Wave3RecoveryReceipt {
  schemaVersion: 1;
  receiptId: string;
  runId: string;
  candidateCommit: string;
  artifact: { id: string; sha256: string };
  environmentSnapshotId: string;
  descriptorHashes: Record<string, string>;
  backupHashes: Record<string, string | null>;
  stages: Array<{ descriptorId: string; strategy: string; ok: boolean; stage: string; rtoMs: number; evidenceId: string | null }>;
  closure: { status: 'closed' };
  createdAt: string;
}
export declare function runWave3RecoveryDrill(options: Wave3RecoveryDrillOptions):
  | { ok: true; receiptPath: string; receipt: Wave3RecoveryReceipt }
  | { ok: false; error: { code: 'WAVE3_CURRENT_MIGRATION_RECEIPT_MISSING' | 'WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH' | 'WAVE3_RECOVERY_DRILL_FAILED'; stage: string; cause?: string } };
