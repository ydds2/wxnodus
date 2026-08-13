import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTrustedVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { CompletionGate } from '../../src/domain/quality/completionGate.js';
import type { EvidenceAttachment, EvidenceRecord } from '../../src/domain/quality/evidence.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8'), stderr = Buffer.alloc(0);
const evidence = (): EvidenceRecord => ({
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
function reviewFixture(root: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
    activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')));
  return { signer, verifier };
}

describe('W1-09 trusted quality foundation', () => {
  it('runs registered verifiers without exposing caller-assignable trust', async () => {
    const registry = createTrustedVerifierRegistry({ fileExists: async () => true });
    const passed = await registry.verify({ id: 'v1', verifierId: 'command.exit-code', input: { actual: 0, expected: 0 } }, new AbortController().signal);
    expect(passed).toMatchObject({ ok: true, value: { status: 'passed' } });
    if (passed.ok) expect(passed.value.authority).not.toHaveProperty('trusted');
    expect(await registry.verify({ id: 'v2', verifierId: 'unknown', input: {} }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'VERIFIER_NOT_FOUND' } });
  });

  it('closes record attachment references and rejects missing/path/id/length/hash defects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-w1-evidence-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    expect(await store.readVerified(ref.value)).toMatchObject({ ok: true, value: { record: { id: 'evidence-1' } } });
    await rm(join(root, 'records', 'evidence-1', 'attachments', 'logs', 'stdout.bin'));
    expect(await store.readVerified(ref.value)).toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_MISSING' } });

    const duplicate = evidence(); duplicate.stderr = { ...duplicate.stderr, attachmentId: duplicate.stdout.attachmentId };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-dup-'))).append(duplicate, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_ID_DUPLICATE' } });
    const escaped = evidence(); escaped.stdout = { ...escaped.stdout, relativePath: '../escape.bin' };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-path-'))).append(escaped, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_PATH_INVALID' } });
    const short = evidence(); short.stdout = { ...short.stdout, bytes: 1 };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-len-'))).append(short, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_LENGTH_MISMATCH' } });
    const corrupt = evidence(); corrupt.stdout = { ...corrupt.stdout, sha256: sha('0') };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-hash-'))).append(corrupt, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_HASH_MISMATCH' } });
  });

  it('verifies canonical bindings/signature/key policy/freshness and rejects replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-review-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
    const attestation = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!attestation.ok) throw new Error(attestation.error.code);
    expect(await verifier.verify(attestation.value, expected, '2026-08-13T00:03:00.000Z')).toMatchObject({ ok: true });
    expect(await verifier.verify(attestation.value, expected, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_REPLAYED' } });
    const forged = { ...attestation.value, signature: Buffer.alloc(64).toString('base64') };
    expect(await reviewFixture(await mkdtemp(join(tmpdir(), 'wxnodus-forged-'))).verifier.verify(forged, expected, '2026-08-13T00:03:00.000Z'))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_SIGNATURE_INVALID' } });
    const stale = await createReviewerAttestation({ ...reviewRun('nonce-stale'), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-12T00:05:00.000Z' });
    if (!stale.ok) throw new Error(stale.error.code);
    expect(await reviewFixture(await mkdtemp(join(tmpdir(), 'wxnodus-stale-'))).verifier.verify(stale.value, expected, '2026-08-13T00:03:00.000Z'))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_STALE' } });
  });

  it('CompletionGate rejects forged trusted objects and accepts only verifier-owned receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-gate-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    const verifiedEvidence = await store.readVerified(ref.value); if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);
    const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
    const signed = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' }); if (!signed.ok) throw new Error(signed.error.code);
    const review = await verifier.verify(signed.value, expected, '2026-08-13T00:03:00.000Z'); if (!review.ok) throw new Error(review.error.code);
    const gate = new CompletionGate(store, verifier), input = { ...expected, requiredCriterionIds: ['criterion-1'], evidence: [verifiedEvidence.value], review: review.value };
    expect(gate.decide(input, '2026-08-13T00:03:01.000Z')).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(gate.decide({ ...input, review: { trusted: true, attestation: signed.value } as never }, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'GATE_UNTRUSTED_INPUT' } });
    expect(gate.decide({ ...input, evidence: [{ ...verifiedEvidence.value }] as never }, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'GATE_UNTRUSTED_INPUT' } });
    expect(gate.decide({ ...input, artifact: { ...input.artifact, commitSha: '8'.repeat(40) } }, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_BINDING_MISMATCH' } });
  });
});
