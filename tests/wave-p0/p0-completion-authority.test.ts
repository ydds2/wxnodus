import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CompletionCoordinator } from '../../src/application/quality/completionCoordinator.js';
import {
  CompletionGate,
  type CompletionDecision,
  type CompletionGateInput,
} from '../../src/domain/quality/completionGate.js';
import {
  CompletionDecisionReceiptIssuer,
  type CompletionDecisionReceipt,
} from '../../src/domain/quality/completionDecisionReceipt.js';
import type { EvidenceAttachment, EvidenceRecord, VerificationStatus } from '../../src/domain/quality/evidence.js';
import {
  createReviewerAttestation,
  ReviewerAttestationVerifier,
  type ReviewBinding,
  type ReviewRun,
} from '../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';
import { RUN_FINAL_STATUSES, type RunFinalStatus } from '../../src/protocol/runs.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8');
const stderr = Buffer.alloc(0);
const AUTHORITY_TIME = '2026-08-13T00:03:01.000Z';
const REQUIRED = ['criterion-1'];

const evidence = (status: VerificationStatus = 'passed'): EvidenceRecord => ({
  id: 'evidence-1',
  schemaVersion: 1,
  runId: 'run-1',
  createdAt: '2026-08-13T00:00:00.000Z',
  objective: { id: 'objective-1', description: 'write verified artifact' },
  criteria: [{
    id: 'criterion-1',
    description: 'command exits zero',
    required: true,
    expected: 0,
    observed: status === 'passed' ? 0 : null,
    status,
  }],
  command: {
    executable: 'npm.cmd',
    argv: ['run', 'build'],
    cwd: 'C:/workspace',
    normalized: 'npm.cmd run build',
    timeoutMs: 60_000,
  },
  exit: { code: status === 'passed' ? 0 : null, signal: null, timedOut: false, aborted: status === 'cancelled' },
  stdout: { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', sha256: digest(stdout), bytes: stdout.byteLength },
  stderr: { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', sha256: digest(stderr), bytes: stderr.byteLength },
  artifact: { id: 'artifact-1', sha256: sha('c'), commitSha: '7'.repeat(40) },
  environment: { snapshotId: 'env-1', sha256: sha('d'), platform: 'win32', arch: 'x64' },
  capability: { snapshotId: 'cap-1', sha256: sha('e'), requiredIds: ['process.execute'] },
  policy: { snapshotId: 'policy-1', sha256: sha('f'), decisionId: 'decision-1' },
  verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: sha('1'), status },
  correlation: { correlationId: 'corr-1', traceId: 'trace-1' },
  lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] },
  authority: { source: 'process-supervisor', sourceRecordId: 'process-1', sourceStatus: status },
});

const attachments = (): EvidenceAttachment[] => [
  { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', content: stdout },
  { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', content: stderr },
];

function reviewRun(record: EvidenceRecord, evidenceRefs: ReviewBinding['evidence'], nonce = 'nonce-1'): ReviewRun {
  return {
    id: 'review-1',
    runId: record.runId,
    maker: { actorId: 'maker-1', contextHash: sha('7') },
    reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
    artifact: record.artifact,
    environment: { snapshotId: record.environment.snapshotId, sha256: record.environment.sha256 },
    policy: { snapshotId: record.policy.snapshotId, sha256: record.policy.sha256 },
    evidence: evidenceRefs,
    requiredCriterionIds: [...REQUIRED],
    status: 'completed',
    startedAt: '2026-08-13T00:01:00.000Z',
    completedAt: '2026-08-13T00:01:30.000Z',
    nonce,
  };
}

async function realFixture(status: VerificationStatus = 'passed', coordinatorTime = AUTHORITY_TIME) {
  const root = await mkdtemp(join(tmpdir(), `wxnodus-completion-${status}-`));
  const store = new FileEvidenceStore(root, () => '2026-08-13T00:02:30.000Z');
  const record = evidence(status);
  const ref = await store.append(record, attachments());
  if (!ref.ok) throw new Error(ref.error.code);
  const verifiedEvidence = await store.readVerified(ref.value);
  if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = {
    issuer: 'review-service-1',
    keyId: 'review-key-1',
    sign: async (hash: Uint8Array) => sign(null, hash, privateKey),
  };
  const reviewerVerifier = new ReviewerAttestationVerifier({
    resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
      issuer,
      keyId,
      algorithm: 'Ed25519' as const,
      publicKey,
      reviewerActorIds: ['reviewer-1'],
      activeFrom: '2026-08-01T00:00:00.000Z',
      activeUntil: '2026-09-01T00:00:00.000Z',
      maxAgeMs: 600_000,
      maxClockSkewMs: 5_000,
    } : undefined,
  }, new FileReviewNonceStore(join(root, 'review-nonces')), () => '2026-08-13T00:03:00.000Z');
  const expected: ReviewBinding = {
    runId: record.runId,
    artifact: record.artifact,
    environment: { snapshotId: record.environment.snapshotId, sha256: record.environment.sha256 },
    policy: { snapshotId: record.policy.snapshotId, sha256: record.policy.sha256 },
    evidence: [ref.value],
    requiredCriterionIds: [...REQUIRED],
  };
  const signed = await createReviewerAttestation(reviewRun(record, [ref.value]), 'passed', signer, {
    issuedAt: '2026-08-13T00:02:00.000Z',
    expiresAt: '2026-08-13T00:07:00.000Z',
  });
  if (!signed.ok) throw new Error(signed.error.code);
  const review = await reviewerVerifier.verify(signed.value, expected);
  if (!review.ok) throw new Error(review.error.code);

  const gate = new CompletionGate(store, reviewerVerifier);
  const coordinator = new CompletionCoordinator(gate, () => coordinatorTime);
  const input: CompletionGateInput = {
    ...expected,
    requiredCriterionIds: [...REQUIRED],
    evidence: [verifiedEvidence.value],
    review: review.value,
  };
  return { root, store, reviewerVerifier, gate, coordinator, input, review: review.value };
}

const sourceDecision = (status: RunFinalStatus = 'succeeded'): CompletionDecision => ({
  runId: 'run-source',
  status,
  artifact: { id: 'artifact-source', sha256: sha('a') },
  criterionResults: [{ id: 'criterion-source', status: 'passed' }],
  evidenceIds: ['evidence-source'],
  reviewInputHash: sha('b'),
  reasons: [],
  decidedAt: AUTHORITY_TIME,
});

describe('W0-01 completion authority', () => {
  it.each([
    ['passed', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['inconclusive', 'inconclusive'],
  ] as const)('preserves a legitimate %s evidence result as %s in an owned receipt', async (verificationStatus, finalStatus) => {
    const fixture = await realFixture(verificationStatus);
    try {
      const result = fixture.coordinator.decide(fixture.input);
      expect(result).toMatchObject({ ok: true, value: { decision: { status: finalStatus, decidedAt: AUTHORITY_TIME } } });
      if (!result.ok) throw new Error(result.error.code);
      expect(fixture.coordinator.owns(result.value)).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(RUN_FINAL_STATUSES)('supports %s as immutable domain receipt data without granting coordinator ownership', status => {
    const issuer = new CompletionDecisionReceiptIssuer();
    const receipt = issuer.issue(sourceDecision(status));
    const realGate = Object.create(CompletionGate.prototype) as CompletionGate;
    const coordinator = new CompletionCoordinator(realGate, () => AUTHORITY_TIME);

    expect(receipt.decision.status).toBe(status);
    expect(issuer.owns(receipt)).toBe(true);
    expect(coordinator.owns(receipt)).toBe(false);
    expect(Object.isFrozen(receipt.decision)).toBe(true);
  });

  it('fails closed when structurally injected with an arbitrary fake gate result', () => {
    const fakeDecision = sourceDecision('succeeded');
    const fakeGate = {
      decide: vi.fn(() => ({ ok: true as const, value: fakeDecision, evidenceIds: fakeDecision.evidenceIds })),
      decideOwned: vi.fn(() => ({ ok: true as const, value: { decision: fakeDecision }, evidenceIds: fakeDecision.evidenceIds })),
    } as unknown as CompletionGate;
    const coordinator = new CompletionCoordinator(fakeGate, () => AUTHORITY_TIME);

    const result = coordinator.decide({} as CompletionGateInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'COMPLETION_GATE_UNTRUSTED' } });
    expect(result.ok ? coordinator.owns(result.value) : false).toBe(false);
  });

  it('bypasses a CompletionGate subclass override and cannot mint from its arbitrary result', async () => {
    const fixture = await realFixture('passed');
    try {
      const fakeDecision = sourceDecision('succeeded');
      class OverridingGate extends CompletionGate {
        override decide(_input: CompletionGateInput, _decidedAt: string) {
          return { ok: true as const, value: fakeDecision, evidenceIds: fakeDecision.evidenceIds };
        }
      }
      const gate = new OverridingGate(fixture.store, fixture.reviewerVerifier);
      const override = vi.spyOn(gate, 'decide');
      const coordinator = new CompletionCoordinator(gate, () => AUTHORITY_TIME);

      const result = coordinator.decide({} as CompletionGateInput);

      expect(override).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? coordinator.owns(result.value) : false).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('bypasses authority subclass owns overrides and rejects arbitrary receipt lookalikes', async () => {
    const fixture = await realFixture('passed');
    try {
      class OverridingStore extends FileEvidenceStore {
        override owns(_receipt: unknown): _receipt is CompletionGateInput['evidence'][number] { return true; }
      }
      class OverridingVerifier extends ReviewerAttestationVerifier {
        override owns(_receipt: unknown): _receipt is CompletionGateInput['review'] { return true; }
      }
      const store = new OverridingStore(fixture.root);
      const verifier = new OverridingVerifier({ resolve: () => undefined }, { consume: async () => ({ ok: true as const, value: undefined }) });
      const storeOwns = vi.spyOn(store, 'owns');
      const verifierOwns = vi.spyOn(verifier, 'owns');
      const gate = new CompletionGate(store, verifier);
      const forged = {
        ...fixture.input,
        evidence: [{ ...fixture.input.evidence[0] }],
        review: { ...fixture.input.review },
      } as CompletionGateInput;

      const result = gate.decide(forged, AUTHORITY_TIME);

      expect(storeOwns).not.toHaveBeenCalled();
      expect(verifierOwns).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, error: { code: 'GATE_UNTRUSTED_INPUT' } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses only its injected clock and ignores a caller-supplied backdated time', async () => {
    const fixture = await realFixture('passed');
    try {
      const callerShape = fixture.coordinator.decide as unknown as (input: CompletionGateInput, decidedAt: string) => ReturnType<CompletionCoordinator['decide']>;
      const result = callerShape.call(fixture.coordinator, fixture.input, '2000-01-01T00:00:00.000Z');

      expect(result).toMatchObject({ ok: true, value: { decision: { decidedAt: AUTHORITY_TIME } } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not issue a completion receipt after an owned review expires', async () => {
    const fixture = await realFixture('passed', '2026-08-13T00:07:00.000Z');
    try {
      const result = fixture.coordinator.decide(fixture.input);

      expect(result).toMatchObject({ ok: false, error: { code: 'COMPLETION_REVIEW_TIME_INVALID' } });
      expect(result.ok ? fixture.coordinator.owns(result.value) : false).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('owns only the exact coordinator-issued deeply immutable receipt', async () => {
    const fixture = await realFixture('passed');
    try {
      const result = fixture.coordinator.decide(fixture.input);
      if (!result.ok) throw new Error(result.error.code);
      const receipt = result.value;

      expect(fixture.coordinator.owns(receipt)).toBe(true);
      expect(fixture.coordinator.owns({ ...receipt })).toBe(false);
      expect(fixture.coordinator.owns(JSON.parse(JSON.stringify(receipt)))).toBe(false);
      expect(fixture.coordinator.owns({ decision: receipt.decision, trusted: true })).toBe(false);
      expect(receipt).not.toHaveProperty('trusted');
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.decision)).toBe(true);
      expect(Object.isFrozen(receipt.decision.artifact)).toBe(true);
      expect(Object.isFrozen(receipt.decision.criterionResults)).toBe(true);
      expect(() => {
        (receipt as CompletionDecisionReceipt & { decision: { artifact: { id: string } } }).decision.artifact.id = 'forged';
      }).toThrow(TypeError);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves a real gate ownership error and never issues a receipt', async () => {
    const fixture = await realFixture('passed');
    try {
      const forgedInput = { ...fixture.input, evidence: [{ ...fixture.input.evidence[0] }] } as CompletionGateInput;
      const result = fixture.coordinator.decide(forgedInput);

      expect(result).toMatchObject({ ok: false, error: { code: 'GATE_UNTRUSTED_INPUT' } });
      expect(result.ok ? fixture.coordinator.owns(result.value) : false).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
