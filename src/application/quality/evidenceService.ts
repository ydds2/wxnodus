// src/application/quality/evidenceService.ts — W3-01：verifier 结果闭合为 EvidenceRecord（authority 冲突 fail closed；trusted 字段剥离）
import { createHash, randomUUID } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import type { EvidenceAttachmentRef, EvidenceRecord } from '../../domain/quality/evidence.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../domain/quality/verifier.js';
import type { VerificationRequest, VerificationResult } from '../../domain/quality/verifier.js';

interface PendingAttachment { attachmentId: string; bytes: Buffer }
export interface EvidenceStorePort {
  appendClosed(record: EvidenceRecord, attachments: readonly PendingAttachment[]): Promise<OperationResult<{ evidenceId: string }>>;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const sha256 = (value: unknown): string => digest(canonical(value));
const failed = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export class EvidenceService {
  constructor(private readonly store: EvidenceStorePort) {}

  async close(request: VerificationRequest, result: VerificationResult): Promise<OperationResult<{ evidenceId: string }>> {
    // 审计源冲突：authority 的源状态与 verifier 结论不一致 → fail closed，绝不产出 passed 证据
    if (result.status !== result.authority.sourceStatus) return failed('EVIDENCE_AUDIT_SOURCE_CONFLICT');
    const pending = [request.execution.stdout, request.execution.stderr, ...(request.execution.attachments ?? [])];
    if (new Set(pending.map(value => value.attachmentId)).size !== pending.length) return failed('EVIDENCE_DUPLICATE_ID');
    if (pending.some(value => !/^[A-Za-z0-9._-]+$/.test(value.attachmentId))) return failed('EVIDENCE_PATH_OUTSIDE_RUN');
    const refs: EvidenceAttachmentRef[] = pending.map(value => ({
      attachmentId: value.attachmentId,
      relativePath: `attachments/${value.attachmentId}`,
      path: `attachments/${value.attachmentId}`,
      sha256: digest(value.bytes),
      bytes: value.bytes.byteLength,
    }));
    const recordId = randomUUID();
    if (pending.some(value => value.attachmentId === recordId)) return failed('EVIDENCE_DUPLICATE_ID');
    const byId = new Map(refs.map(ref => [ref.attachmentId, ref]));
    const stdout = byId.get(request.execution.stdout.attachmentId);
    const stderr = byId.get(request.execution.stderr.attachmentId);
    if (!stdout || !stderr) return failed('EVIDENCE_ATTACHMENT_MISSING');

    // W1-09 合同：trusted 是 legacy 调用方字面量兼容项——剥离，authority 只保留审计元数据
    const { trusted: _dropped, ...authority } = result.authority;
    void _dropped;

    const record: EvidenceRecord = {
      id: recordId,
      schemaVersion: 1,
      runId: request.runId,
      createdAt: new Date().toISOString(),
      objective: request.objective,
      criteria: [{
        id: request.criterion.id,
        description: request.criterion.description,
        required: request.criterion.required,
        expected: request.criterion.expected,
        observed: result.observed,
        status: result.status,
        failureCode: result.failureCode,
      }],
      command: request.execution.command,
      exit: request.execution.exit,
      artifact: { id: request.context.artifactId, sha256: request.context.artifactSha256 },
      stdout,
      stderr,
      // attachments 只含 stdout/stderr 之外的额外附件（stdout/stderr 已单列——重复引用会让闭包校验误报 EVIDENCE_DUPLICATE_ID）
      attachments: refs.filter(ref =>
        ref.attachmentId !== request.execution.stdout.attachmentId && ref.attachmentId !== request.execution.stderr.attachmentId),
      closure: { status: 'closed', attachmentIds: refs.map(ref => ref.attachmentId).sort() },
      environment: {
        snapshotId: request.context.environmentSnapshotId,
        sha256: request.context.environmentSha256,
        platform: process.platform,
        arch: process.arch,
      },
      capability: {
        snapshotId: request.context.capabilitySnapshotId,
        sha256: request.context.capabilitySha256,
        requiredIds: [...BUILTIN_VERIFIER_DESCRIPTORS[request.verifierId].requiredCapabilities],
      },
      policy: {
        snapshotId: request.context.policySnapshotId,
        sha256: request.context.policySha256,
        decisionId: request.context.policyDecisionId,
      },
      verifier: { id: request.verifierId, version: '1.0.0', inputSha256: sha256(request.input), status: result.status },
      correlation: { correlationId: request.context.correlationId, traceId: request.context.traceId },
      lineage: {
        sessionId: request.context.sessionId,
        artifactIds: [request.context.artifactId],
        priorEvidenceIds: result.evidenceIds,
      },
      authority,
    };
    return this.store.appendClosed(record, pending);
  }
}
