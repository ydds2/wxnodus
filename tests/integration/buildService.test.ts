// tests/integration/buildService.test.ts — W3-07：Acceptance-driven BuildService（staging 隔离/预览审批/静态入口/开放域）
// W0-01：commit authority 只来自注入的 genuine CompletionCoordinator 签发的 owned succeeded receipt；
// 任何结构化决策、fake coordinator、错误 input 或非 succeeded 终态都 abandon staging，绝不提交。
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BuildService } from '../../src/application/build/buildService.js';
import type { BuildServicePorts } from '../../src/application/build/buildService.js';
import { CompletionCoordinator } from '../../src/application/quality/completionCoordinator.js';
import { CompletionGate, type CompletionGateInput } from '../../src/domain/quality/completionGate.js';
import type { EvidenceAttachment, EvidenceRecord, VerificationStatus } from '../../src/domain/quality/evidence.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8');
const stderr = Buffer.alloc(0);
const AUTHORITY_TIME = '2026-08-13T00:03:01.000Z';

const spec = [
  { id: 'starts', required: true, description: 'server starts', verifierId: 'process.readiness', expected: true, evidenceRequirements: ['stdout'] },
  { id: 'reads-back', required: true, description: 'data reads back', verifierId: 'database.query', expected: { name: 'x' }, evidenceRequirements: ['stdout'] },
];

const snapshotInput = {
  runId: 'run-1',
  artifactId: 'artifact-1',
  artifactHash: 'c'.repeat(64),
  environmentSnapshotId: 'env-1',
  environmentHash: 'd'.repeat(64),
  capabilitySnapshotId: 'cap-1',
  policySnapshotId: 'policy-1',
  policyHash: 'f'.repeat(64),
};

const evidence = (status: VerificationStatus = 'passed'): EvidenceRecord => ({
  id: 'evidence-1',
  schemaVersion: 1,
  runId: 'run-1',
  createdAt: '2026-08-13T00:00:00.000Z',
  objective: { id: 'objective-1', description: 'write verified artifact' },
  criteria: [
    {
      id: 'starts', description: 'server starts', required: true, expected: true,
      observed: status === 'passed', status,
    },
    {
      id: 'reads-back', description: 'data reads back', required: true, expected: { name: 'x' },
      observed: status === 'passed' ? { name: 'x' } : null, status,
    },
  ],
  command: { executable: 'npm.cmd', argv: ['run', 'build'], cwd: 'C:/workspace', normalized: 'npm.cmd run build', timeoutMs: 60_000 },
  exit: { code: status === 'passed' ? 0 : null, signal: null, timedOut: false, aborted: false },
  stdout: { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', sha256: digest(stdout), bytes: stdout.byteLength },
  stderr: { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', sha256: digest(stderr), bytes: stderr.byteLength },
  artifact: { id: 'artifact-1', sha256: 'c'.repeat(64), commitSha: '7'.repeat(40) },
  environment: { snapshotId: 'env-1', sha256: 'd'.repeat(64), platform: 'win32', arch: 'x64' },
  capability: { snapshotId: 'cap-1', sha256: sha('e'), requiredIds: ['process.execute'] },
  policy: { snapshotId: 'policy-1', sha256: 'f'.repeat(64), decisionId: 'decision-1' },
  verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: sha('1'), status },
  correlation: { correlationId: 'corr-1', traceId: 'trace-1' },
  lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] },
  authority: { source: 'process-supervisor', sourceRecordId: 'process-1', sourceStatus: status },
});

const attachments = (): EvidenceAttachment[] => [
  { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', content: stdout },
  { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', content: stderr },
];

async function authorityFixture(status: VerificationStatus = 'passed') {
  const root = await mkdtemp(join(tmpdir(), `wxnodus-build-service-${status}-`));
  const store = new FileEvidenceStore(root, () => '2026-08-13T00:02:30.000Z');
  const record = evidence(status);
  const appended = await store.append(record, attachments());
  if (!appended.ok) throw new Error(appended.error.code);
  const verifiedEvidence = await store.readVerified(appended.value);
  if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = {
    issuer: 'review-service-1',
    keyId: 'review-key-1',
    sign: async (hash: Uint8Array) => sign(null, hash, privateKey),
  };
  const reviewerVerifier = new ReviewerAttestationVerifier({
    resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
      issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'],
      activeFrom: '2026-08-01T00:00:00.000Z', activeUntil: '2026-09-01T00:00:00.000Z',
      maxAgeMs: 600_000, maxClockSkewMs: 5_000,
    } : undefined,
  }, new FileReviewNonceStore(join(root, 'review-nonces')), () => '2026-08-13T00:03:00.000Z');
  const binding: ReviewBinding = {
    runId: record.runId,
    artifact: record.artifact,
    environment: { snapshotId: record.environment.snapshotId, sha256: record.environment.sha256 },
    policy: { snapshotId: record.policy.snapshotId, sha256: record.policy.sha256 },
    evidence: [appended.value],
    requiredCriterionIds: ['starts', 'reads-back'],
  };
  const run: ReviewRun = {
    id: 'review-1', runId: record.runId,
    maker: { actorId: 'maker-1', contextHash: sha('7') },
    reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
    artifact: record.artifact,
    environment: binding.environment,
    policy: binding.policy,
    evidence: binding.evidence,
    requiredCriterionIds: binding.requiredCriterionIds,
    status: 'completed',
    startedAt: '2026-08-13T00:01:00.000Z',
    completedAt: '2026-08-13T00:01:30.000Z',
    nonce: `nonce-build-${status}`,
  };
  const attestation = await createReviewerAttestation(run, 'passed', signer, {
    issuedAt: '2026-08-13T00:02:00.000Z',
    expiresAt: '2026-08-13T00:07:00.000Z',
  });
  if (!attestation.ok) throw new Error(attestation.error.code);
  const review = await reviewerVerifier.verify(attestation.value, binding);
  if (!review.ok) throw new Error(review.error.code);

  const coordinator = new CompletionCoordinator(new CompletionGate(store, reviewerVerifier), () => AUTHORITY_TIME);
  const gateInput: CompletionGateInput = {
    ...binding,
    requiredCriterionIds: [...binding.requiredCriterionIds],
    evidence: [verifiedEvidence.value],
    review: review.value,
  };
  return { root, coordinator, gateInput };
}

function makePorts(overrides: Partial<BuildServicePorts> = {}, gateInput: CompletionGateInput | null = null) {
  const nodesRun: string[] = [];
  const ports: BuildServicePorts = {
    workspace: {
      stage: vi.fn(async () => ({ ok: true as const, value: { stagingDir: 'C:/tmp/stage-1' } })),
      commit: vi.fn(async () => ({ ok: true as const, value: undefined })),
      abandon: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ ok: true as const, value: { changed: [] } })),
    },
    verifierMap: { resolve: vi.fn(criterion => ({ ok: true as const, value: { verifierId: criterion.verifierId } })) },
    nodes: vi.fn(() => [
      { id: 'install', dependsOn: [], run: async () => { nodesRun.push('install'); return { ok: true as const, value: undefined }; } },
      { id: 'evidence', dependsOn: ['install'], run: async () => { nodesRun.push('evidence'); return { ok: true as const, value: undefined }; } },
    ]),
    staticEntry: { verify: vi.fn(async () => ({ ok: true as const, value: { servesRoot: true } })) },
    completionInput: vi.fn(async () => gateInput
      ? ({ ok: true as const, value: gateInput })
      : ({
        ok: false as const,
        error: { code: 'BUILD_COMPLETION_INPUT_FAILED', message: 'x', messageKey: 'x', retryable: false },
      })),
    ...overrides,
  };
  return { ports, nodesRun };
}

const request = { spec, targetDir: 'C:/workspace/proj', dataDir: 'C:/data', snapshotInput };

describe('BuildService', () => {
  it('rejects incomplete specs and unmapped criteria before any staging', async () => {
    const fixture = await authorityFixture('passed');
    try {
      const { ports } = makePorts({}, fixture.gateInput);
      const service = new BuildService(ports, fixture.coordinator);
      expect(await service.compileAndRun({ ...request, spec: [{ id: 'x' }] }, AbortSignal.timeout(100)))
        .toMatchObject({ ok: false, error: { code: 'BUILD_SPEC_INVALID' } });
      expect(await service.compileAndRun(request, AbortSignal.timeout(100)))
        .toMatchObject({ ok: true, value: { committed: true, decision: { status: 'succeeded' } } });
      expect(ports.workspace.stage).toHaveBeenCalledTimes(1);

      const unmapped = makePorts({
        verifierMap: { resolve: vi.fn(() => ({
          ok: false as const,
          error: { code: 'BUILD_VERIFIER_MAPPING_MISSING', message: 'x', messageKey: 'x', retryable: false },
        })) },
      }, fixture.gateInput);
      expect(await new BuildService(unmapped.ports, fixture.coordinator).compileAndRun(request, AbortSignal.timeout(100)))
        .toMatchObject({ ok: false, error: { code: 'BUILD_VERIFIER_MAPPING_MISSING' } });
      expect(unmapped.ports.workspace.stage).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('never fabricates completion for open-domain requests', async () => {
    const { ports } = makePorts();
    expect(await new BuildService(ports, {} as unknown as CompletionCoordinator)
      .compileAndRun({ ...request, openDomain: true }, AbortSignal.timeout(100)))
      .toMatchObject({ ok: false, error: { code: 'BUILD_OPEN_DOMAIN_UNSUPPORTED' } });
    expect(ports.workspace.stage).not.toHaveBeenCalled();
  });

  it('requires preview approval before mutating an existing project', async () => {
    const fixture = await authorityFixture('passed');
    try {
      const ports = makePorts({}, fixture.gateInput);
      ports.ports.workspace.diff = vi.fn(async () => ({ ok: true as const, value: { changed: ['src/index.ts'] } }));
      expect(await new BuildService(ports.ports, fixture.coordinator)
        .compileAndRun({ ...request, existingProject: true }, AbortSignal.timeout(100)))
        .toMatchObject({ ok: false, error: { code: 'BUILD_PREVIEW_APPROVAL_REQUIRED' } });
      expect(await new BuildService(ports.ports, fixture.coordinator)
        .compileAndRun({ ...request, existingProject: true, previewApproved: true }, AbortSignal.timeout(100)))
        .toMatchObject({ ok: true, value: { committed: true } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails with BUILD_STATIC_ENTRY_MISSING and abandons staging when the generated server cannot serve /', async () => {
    const fixture = await authorityFixture('passed');
    try {
      const ports = makePorts({
        staticEntry: { verify: vi.fn(async () => ({ ok: true as const, value: { servesRoot: false } })) },
      }, fixture.gateInput);
      const result = await new BuildService(ports.ports, fixture.coordinator).compileAndRun(request, AbortSignal.timeout(100));
      expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_STATIC_ENTRY_MISSING' } });
      expect(ports.ports.workspace.commit).not.toHaveBeenCalled();
      expect(ports.ports.workspace.abandon).toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a coordinator that is not a genuine CompletionCoordinator and never commits', async () => {
    const fixture = await authorityFixture('passed');
    try {
      const ports = makePorts({}, fixture.gateInput);
      const result = await new BuildService(ports.ports, {} as unknown as CompletionCoordinator)
        .compileAndRun(request, AbortSignal.timeout(100));

      expect(result).toMatchObject({ ok: false, error: { code: 'COMPLETION_COORDINATOR_UNTRUSTED' } });
      expect(ports.ports.workspace.commit).not.toHaveBeenCalled();
      expect(ports.ports.workspace.abandon).toHaveBeenCalled();
      expect(ports.ports.completionInput).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('abandons staging when completion input cannot be assembled and never commits', async () => {
    const fixture = await authorityFixture('passed');
    try {
      const ports = makePorts();
      const result = await new BuildService(ports.ports, fixture.coordinator).compileAndRun(request, AbortSignal.timeout(100));

      expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_COMPLETION_INPUT_FAILED' } });
      expect(ports.ports.workspace.commit).not.toHaveBeenCalled();
      expect(ports.ports.workspace.abandon).toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('abandons staging on an owned non-succeeded decision and never commits', async () => {
    const fixture = await authorityFixture('failed');
    try {
      const ports = makePorts({}, fixture.gateInput);
      const result = await new BuildService(ports.ports, fixture.coordinator).compileAndRun(request, AbortSignal.timeout(100));

      expect(result).toMatchObject({
        ok: true,
        value: { committed: false, decision: { status: 'failed' } },
      });
      expect(ports.ports.workspace.commit).not.toHaveBeenCalled();
      expect(ports.ports.workspace.abandon).toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('commits only on an owned succeeded receipt from the genuine coordinator', async () => {
    const fixture = await authorityFixture('passed');
    try {
      const ports = makePorts({}, fixture.gateInput);
      const result = await new BuildService(ports.ports, fixture.coordinator).compileAndRun(request, AbortSignal.timeout(100));

      expect(result).toMatchObject({
        ok: true,
        value: { committed: true, decision: { status: 'succeeded', reasons: [] } },
      });
      expect(ports.ports.workspace.commit).toHaveBeenCalledWith('C:/tmp/stage-1', request.targetDir);
      expect(ports.ports.workspace.abandon).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
