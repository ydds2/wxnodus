import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompletionGate, type CompletionGateInput } from '../../../src/domain/quality/completionGate.js';
import type { EvidenceAttachment, EvidenceRecord, VerificationStatus } from '../../../src/domain/quality/evidence.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewerAttestation, type ReviewRun } from '../../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../../src/infrastructure/quality/fileReviewNonceStore.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8');
const stderr = Buffer.alloc(0);
const DECIDED_AT = '2026-08-13T00:03:01.000Z';

const criterion = (id: string, status: VerificationStatus = 'passed') => ({
  id,
  description: `criterion ${id}`,
  required: true,
  expected: true,
  observed: status === 'passed',
  status,
});

const evidence = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'evidence-1', schemaVersion: 1, runId: 'run-1', createdAt: '2026-08-13T00:00:00.000Z',
  objective: { id: 'objective-1', description: 'write verified artifact' },
  criteria: [criterion('criterion-A')],
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

function reviewRun(record: EvidenceRecord, evidenceRefs: ReviewBinding['evidence'], requiredCriterionIds: string[]): ReviewRun {
  return {
    id: 'review-1', runId: record.runId,
    maker: { actorId: 'maker-1', contextHash: sha('7') }, reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
    artifact: record.artifact,
    environment: { snapshotId: record.environment.snapshotId, sha256: record.environment.sha256 },
    policy: { snapshotId: record.policy.snapshotId, sha256: record.policy.sha256 },
    evidence: evidenceRefs, requiredCriterionIds: [...requiredCriterionIds], status: 'completed',
    startedAt: '2026-08-13T00:01:00.000Z', completedAt: '2026-08-13T00:01:30.000Z', nonce: 'nonce-1',
  };
}

const canonicalValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`;
};

async function resignSchemaVersion(
  attestation: ReviewerAttestation,
  schemaVersion: 1 | 2,
  signer: { sign(hash: Uint8Array): Promise<Uint8Array> },
  nonce: string,
): Promise<ReviewerAttestation> {
  const { reviewInputHash: _reviewInputHash, signature: _signature, ...unsigned } = attestation;
  const body = { ...unsigned, schemaVersion, nonce };
  const reviewInputHash = createHash('sha256').update(canonicalValue(body)).digest('hex');
  return {
    ...body,
    reviewInputHash,
    signature: Buffer.from(await signer.sign(Buffer.from(reviewInputHash, 'hex'))).toString('base64'),
  } as unknown as ReviewerAttestation;
}

async function fixture(record: EvidenceRecord, root: string, signedRequiredIds: string[], inputRequiredIds = signedRequiredIds) {
  const store = new FileEvidenceStore(root, () => '2026-08-13T00:02:30.000Z');
  const appended = await store.append(record, attachments());
  if (!appended.ok) throw new Error(appended.error.code);
  const verifiedEvidence = await store.readVerified(appended.value);
  if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
    activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')), () => '2026-08-13T00:03:00.000Z');
  const expected: ReviewBinding = {
    runId: record.runId, artifact: record.artifact,
    environment: { snapshotId: record.environment.snapshotId, sha256: record.environment.sha256 },
    policy: { snapshotId: record.policy.snapshotId, sha256: record.policy.sha256 },
    evidence: [appended.value], requiredCriterionIds: [...signedRequiredIds],
  };
  const signed = await createReviewerAttestation(reviewRun(record, [appended.value], signedRequiredIds), 'passed', signer,
    { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
  if (!signed.ok) throw new Error(signed.error.code);
  const review = await verifier.verify(signed.value, expected);
  if (!review.ok) throw new Error(review.error.code);
  const gate = new CompletionGate(store, verifier);
  const input: CompletionGateInput = { ...expected, requiredCriterionIds: [...inputRequiredIds], evidence: [verifiedEvidence.value], review: review.value };
  return { gate, input, store, signer, verifier, record, ref: appended.value, binding: expected };
}

describe('CompletionGate authoritative required criteria', () => {
  it('accepts explicitly closed W3-shaped records with exact attachment closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-closed-'));
    try {
      const record = evidence({ attachments: [], closure: { status: 'closed', attachmentIds: ['stderr-1', 'stdout-1'] } });
      const { gate, input } = await fixture(record, root, ['criterion-A']);
      expect(gate.decide(input, DECIDED_AT)).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects the explicit omission attack: A passed, B failed, caller supplies only A', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-required-omission-'));
    try {
      const record = evidence({
        criteria: [criterion('criterion-A', 'passed'), criterion('criterion-B', 'failed')],
        verifier: { ...evidence().verifier, status: 'failed' },
        authority: { ...evidence().authority, sourceStatus: 'failed' },
      });
      const { gate, input } = await fixture(record, root, ['criterion-A']);
      const result = gate.decide(input, DECIDED_AT);
      expect(result).toMatchObject({ ok: false, error: { code: 'COMPLETION_REQUIRED_CRITERION_BINDING_MISMATCH' } });
      expect(result).not.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves incomplete semantics for a signed legitimate requirement with missing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-required-missing-'));
    try {
      const { gate, input } = await fixture(evidence(), root, ['criterion-A', 'criterion-B']);
      expect(gate.decide(input, DECIDED_AT)).toMatchObject({
        ok: true, value: { status: 'incomplete', reasons: ['COMPLETION_REQUIRED_CRITERION_MISSING'] },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('accepts evidence whose required criteria are recorded in a different order from the signed binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-required-evidence-order-'));
    try {
      const record = evidence({ criteria: [criterion('criterion-B'), criterion('criterion-A')] });
      const { gate, input } = await fixture(record, root, ['criterion-A', 'criterion-B']);
      expect(gate.decide(input, DECIDED_AT)).toMatchObject({
        ok: true,
        value: {
          status: 'succeeded',
          criterionResults: [
            { id: 'criterion-A', status: 'passed' },
            { id: 'criterion-B', status: 'passed' },
          ],
        },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires exact normalized order match between gate input and signed review requirements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-required-order-'));
    try {
      const { gate, input } = await fixture(evidence(), root, ['criterion-A', 'criterion-B'], ['criterion-B', 'criterion-A']);
      expect(gate.decide(input, DECIDED_AT)).toMatchObject({ ok: false, error: { code: 'REVIEW_BINDING_MISMATCH' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never authorizes succeeded on a historical v1 attestation even when its signature verifies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-v1-schema-'));
    try {
      const { gate, input, signer, verifier, record, ref, binding } = await fixture(evidence(), root, ['criterion-A']);
      const v1 = await resignSchemaVersion(input.review.attestation as ReviewerAttestation, 1, signer, 'nonce-v1');
      const v1Review = await verifier.verify(v1, binding);
      expect(v1Review).toMatchObject({ ok: true, value: { attestation: { schemaVersion: 1 } } });
      if (!v1Review.ok) throw new Error(v1Review.error.code);

      const decision = gate.decide({ ...input, review: v1Review.value }, DECIDED_AT);

      expect(decision).toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_SCHEMA_UNSUPPORTED' } });
      expect(decision).not.toMatchObject({ ok: true, value: { status: 'succeeded' } });
      expect(record.id).toBe(ref.id);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects duplicate, malformed, sparse, and empty gate requirement bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-required-shapes-'));
    try {
      const { gate, input } = await fixture(evidence(), root, ['criterion-A']);
      for (const requiredCriterionIds of [[], ['criterion-A', 'criterion-A'], [''], new Array(1)]) {
        expect(gate.decide({ ...input, requiredCriterionIds } as CompletionGateInput, DECIDED_AT).ok).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
