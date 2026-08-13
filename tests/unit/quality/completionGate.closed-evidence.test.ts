// tests/unit/quality/completionGate.closed-evidence.test.ts — W3-01：CompletionGate 只消费闭包证据
// 未闭包 → blocked/COMPLETION_EVIDENCE_NOT_CLOSED；缺失/失败 required criterion → incomplete/failed 稳定码。
// W1-09 收据信任模型延续：receipt 必须来自 store 实例签发（WeakSet owns），authority 无 trusted 字段。
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompletionGate } from '../../../src/domain/quality/completionGate.js';
import type { EvidenceAttachment, EvidenceRecord } from '../../../src/domain/quality/evidence.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewRun } from '../../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../../src/infrastructure/quality/fileReviewNonceStore.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8'), stderr = Buffer.alloc(0);
const evidence = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'evidence-1', schemaVersion: 1, runId: 'run-1', createdAt: '2026-08-13T00:00:00.000Z',
  objective: { id: 'objective-1', description: 'write verified artifact' },
  criteria: [{ id: 'criterion-1', description: 'command exits zero', required: true, expected: 0, observed: 0, status: 'passed' }],
  command: { executable: 'npm.cmd', argv: ['run', 'build'], cwd: 'C:/workspace', normalized: 'npm.cmd run build', timeoutMs: 60_000 },
  exit: { code: 0, signal: null, timedOut: false, aborted: false },
  stdout: { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', sha256: digest(stdout), bytes: stdout.byteLength },
  stderr: { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', sha256: digest(stderr), bytes: stderr.byteLength },
  artifact: { id: 'artifact-1', sha256: sha('c'), commitSha: '7'.repeat(40) },
  environment: { snapshotId: 'env-1', sha256: sha('d'), platform: 'win32', arch: 'x64' },
  capability: { snapshotId: 'cap-1', sha256: sha('e'), requiredIds: ['process.execute'] },
  policy: { snapshotId: 'policy-1', sha256: sha('f'), decisionId: 'decision-1' },
  verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: sha('1'), status: 'passed' },
  correlation: { correlationId: 'corr-1', traceId: 'trace-1' },
  lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] },
  authority: { source: 'process-supervisor', sourceRecordId: 'process-1', sourceStatus: 'passed' },
  ...overrides,
});
const attachments = (): EvidenceAttachment[] => [
  { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', content: stdout },
  { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', content: stderr },
];
const reviewRun = (nonce = 'nonce-1'): ReviewRun => ({
  id: 'review-1', runId: 'run-1', maker: { actorId: 'maker-1', contextHash: sha('7') }, reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
  artifact: evidence().artifact, environment: { snapshotId: 'env-1', sha256: sha('d') }, policy: { snapshotId: 'policy-1', sha256: sha('f') },
  evidence: [], status: 'completed', startedAt: '2026-08-13T00:01:00.000Z', completedAt: '2026-08-13T00:01:30.000Z', nonce,
});
const binding = (evidenceRefs: ReviewBinding['evidence']): ReviewBinding => ({ runId: 'run-1', artifact: evidence().artifact,
  environment: { snapshotId: 'env-1', sha256: sha('d') }, policy: { snapshotId: 'policy-1', sha256: sha('f') }, evidence: evidenceRefs });

async function decideFixture(record: EvidenceRecord, root: string, requiredCriterionIds = ['criterion-1']) {
  const store = new FileEvidenceStore(root);
  const ref = await store.append(record, attachments()); if (!ref.ok) throw new Error(ref.error.code);
  const verifiedEvidence = await store.readVerified(ref.value); if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
    activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')));
  const expected = binding([ref.value]);
  const signed = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
    { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' }); if (!signed.ok) throw new Error(signed.error.code);
  const review = await verifier.verify(signed.value, expected, '2026-08-13T00:03:00.000Z'); if (!review.ok) throw new Error(review.error.code);
  const gate = new CompletionGate(store, verifier);
  return gate.decide({ ...expected, requiredCriterionIds, evidence: [verifiedEvidence.value], review: review.value }, '2026-08-13T00:03:01.000Z');
}

describe('CompletionGate closed evidence', () => {
  it('accepts W3-shaped records only when closure is explicitly closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-closed-'));
    try {
      const closedRecord = evidence({
        attachments: [evidence().stdout, evidence().stderr],
        closure: { status: 'closed', attachmentIds: ['stderr-1', 'stdout-1'] },
      });
      expect(await decideFixture(closedRecord, join(root, 'a'))).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks W3-shaped records without closure and never lets them pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-unclosed-'));
    try {
      const unclosedRecord = evidence({ attachments: [evidence().stdout, evidence().stderr] });
      const decision = await decideFixture(unclosedRecord, root);
      expect(decision).toMatchObject({
        ok: true,
        value: { status: 'blocked', reasons: ['COMPLETION_EVIDENCE_NOT_CLOSED'], criterionResults: [] },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports missing required criterion as incomplete with a stable code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-missing-'));
    try {
      const decision = await decideFixture(evidence(), root, ['criterion-1', 'criterion-2']);
      expect(decision).toMatchObject({
        ok: true,
        value: { status: 'incomplete', reasons: ['COMPLETION_REQUIRED_CRITERION_MISSING'] },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports failed required criterion as failed with a stable code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-failed-'));
    try {
      const failedRecord = evidence({
        criteria: [{ id: 'criterion-1', description: 'command exits zero', required: true, expected: 0, observed: 1, status: 'failed' }],
      });
      const decision = await decideFixture(failedRecord, root);
      expect(decision).toMatchObject({
        ok: true,
        value: { status: 'failed', reasons: ['COMPLETION_REQUIRED_CRITERION_FAILED'] },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
