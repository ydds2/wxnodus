// src/domain/quality/evidence.ts — 不可信输入契约：evidence 记录/附件引用/receipt（无 trusted 字段）
export type VerificationStatus = 'passed' | 'failed' | 'inconclusive' | 'cancelled';
export type AuthoritySource = 'process-supervisor' | 'filesystem-reader' | 'workspace-reader' | 'http-client' |
  'database-client' | 'browser-driver' | 'uia-driver' | 'ocr-engine' | 'approval-repository';
export interface ArtifactBinding { id: string; sha256: string; commitSha: string }
export interface EvidenceAttachmentRef { attachmentId: string; relativePath: string; sha256: string; bytes: number }
export interface EvidenceAttachment { attachmentId: string; relativePath: string; content: Uint8Array }
export interface EvidenceRecord {
  id: string; schemaVersion: 1; runId: string; createdAt: string; objective: { id: string; description: string };
  criteria: Array<{ id: string; description: string; required: boolean; expected: unknown; observed: unknown; status: VerificationStatus; failureCode?: string }>;
  command: { executable: string; argv: string[]; cwd: string; normalized: string; timeoutMs: number };
  exit: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean };
  stdout: EvidenceAttachmentRef; stderr: EvidenceAttachmentRef; artifact: ArtifactBinding;
  environment: { snapshotId: string; sha256: string; platform: NodeJS.Platform; arch: string };
  capability: { snapshotId: string; sha256: string; requiredIds: string[] }; policy: { snapshotId: string; sha256: string; decisionId: string };
  verifier: { id: string; version: string; inputSha256: string; status: VerificationStatus };
  correlation: { correlationId: string; causationId?: string; traceId: string };
  lineage: { sessionId: string; parentRunId?: string; taskId?: string; artifactIds: string[]; priorEvidenceIds: string[] };
  authority: { source: AuthoritySource; sourceRecordId: string; sourceStatus: VerificationStatus };
}
export interface EvidenceRef { id: string; sha256: string }
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface VerifiedEvidenceReceipt { readonly record: DeepReadonly<EvidenceRecord>; readonly ref: DeepReadonly<EvidenceRef>; readonly verifiedAt: string }
