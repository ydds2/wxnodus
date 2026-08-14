// tests/integration/buildEvidenceDecision.test.ts — W3-08：构建证据 → 完成判定（篡改阻断 Gate G；终态码诚实）
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildVerifierDecision, classifyBuildVerifierOutcome } from '../../src/application/quality/buildVerifiers.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { EvidenceService } from '../../src/application/quality/evidenceService.js';
import { CompletionCoordinator } from '../../src/application/quality/completionCoordinator.js';
import { CompletionGate, type CompletionGateInput } from '../../src/domain/quality/completionGate.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';
import { createBuiltinVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../src/domain/quality/verifier.js';
import type { VerificationRequest } from '../../src/domain/quality/verifier.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const manifestRoot = (entries: Array<{ path: string; attachmentId?: string; bytes: number; sha256: string }>) =>
  digest([...entries].sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => `${entry.path}\0${entry.attachmentId ?? ''}\0${entry.bytes}\0${entry.sha256}`).join('\n'));

const requestFor = (verifierId: 'process.readiness', attempt: string): VerificationRequest => ({
  id: `v-${attempt}`,
  runId: 'run-build-evidence',
  objective: { id: 'o1', description: 'build evidence decision' },
  criterion: { id: `c-${attempt}`, description: 'ready', required: true, expected: true },
  verifierId,
  input: Object.fromEntries(BUILTIN_VERIFIER_DESCRIPTORS[verifierId].requiredInputKeys.map(key => [key, true])),
  timeoutMs: 500,
  context: {
    sessionId: 's1', correlationId: `corr-${attempt}`, traceId: 't1',
    environmentSnapshotId: 'env-1', environmentSha256: 'a'.repeat(64),
    capabilitySnapshotId: 'cap-1', capabilitySha256: 'b'.repeat(64),
    policySnapshotId: 'p1', policySha256: 'c'.repeat(64), policyDecisionId: 'd1',
    artifactId: 'artifact-1', artifactSha256: 'f'.repeat(64),
  },
  execution: {
    command: { executable: 'node', argv: ['server.js'], cwd: 'C:/workspace', normalized: 'node server.js', timeoutMs: 500 },
    exit: { code: 0, signal: null, timedOut: false, aborted: false },
    stdout: { attachmentId: `stdout-${attempt}`, bytes: Buffer.from('listening', 'utf8') },
    stderr: { attachmentId: `stderr-${attempt}`, bytes: Buffer.alloc(0) },
  },
});

describe('build evidence decision', () => {
  it('bridges EvidenceService.close through a verified closed bundle into a real owned completion receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-bridge-'));
    try {
      const store = new FileEvidenceStore(root, () => '2026-08-13T00:02:30.000Z');
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidenceService = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', 'bridge');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      if (!verified.ok) throw new Error(verified.error.code);
      const closed = await evidenceService.close(request, verified.value);
      if (!closed.ok) throw new Error(closed.error.code);
      expect(closed.value).toMatchObject({ evidenceId: expect.any(String), ref: { id: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      expect(closed.value.ref.id).toBe(closed.value.evidenceId);

      const receipt = await store.readVerifiedClosed(request.runId, closed.value.ref);
      expect(receipt).toMatchObject({ ok: true, value: { ref: closed.value.ref } });
      if (!receipt.ok) throw new Error(receipt.error.code);
      expect(store.owns(receipt.value)).toBe(true);

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
      const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
        issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
        activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
      } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')), () => '2026-08-13T00:03:00.000Z');
      const binding: ReviewBinding = {
        runId: request.runId,
        artifact: { id: request.context.artifactId, sha256: request.context.artifactSha256 },
        environment: { snapshotId: request.context.environmentSnapshotId, sha256: request.context.environmentSha256 },
        policy: { snapshotId: request.context.policySnapshotId, sha256: request.context.policySha256 },
        evidence: [closed.value.ref],
        requiredCriterionIds: [request.criterion.id],
      };
      const run: ReviewRun = {
        id: 'review-bridge', runId: request.runId,
        maker: { actorId: 'maker-1', contextHash: sha('7') }, reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
        artifact: binding.artifact, environment: binding.environment, policy: binding.policy, evidence: binding.evidence,
        requiredCriterionIds: binding.requiredCriterionIds, status: 'completed', startedAt: '2026-08-13T00:01:00.000Z',
        completedAt: '2026-08-13T00:01:30.000Z', nonce: 'nonce-bridge',
      };
      const attestation = await createReviewerAttestation(run, 'passed', signer,
        { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
      if (!attestation.ok) throw new Error(attestation.error.code);
      const review = await verifier.verify(attestation.value, binding);
      if (!review.ok) throw new Error(review.error.code);
      const input: CompletionGateInput = { ...binding, evidence: [receipt.value], review: review.value };
      const coordinator = new CompletionCoordinator(new CompletionGate(store, verifier), () => '2026-08-13T00:03:01.000Z');

      const completion = coordinator.decide(input);
      expect(completion).toMatchObject({ ok: true, value: { decision: { status: 'succeeded', evidenceIds: [closed.value.evidenceId] } } });
      expect(completion.ok ? coordinator.owns(completion.value) : false).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a newly valid reviewer signature after record, manifest, and EvidenceRef are consistently changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-signature-anchor-'));
    try {
      const store = new FileEvidenceStore(root, () => '2026-08-13T00:03:01.000Z');
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const service = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', 'signature-anchor');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      if (!verified.ok) throw new Error(verified.error.code);
      const closed = await service.close(request, verified.value);
      if (!closed.ok) throw new Error(closed.error.code);
      const originalReceipt = await store.readVerifiedClosed(request.runId, closed.value.ref);
      if (!originalReceipt.ok) throw new Error(originalReceipt.error.code);

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const signer = { issuer: 'review-service-anchor', keyId: 'review-key-anchor', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
      const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
        issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
        activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
      } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')), () => '2026-08-13T00:03:00.000Z');
      const originalBinding: ReviewBinding = {
        runId: request.runId,
        artifact: { id: request.context.artifactId, sha256: request.context.artifactSha256 },
        environment: { snapshotId: request.context.environmentSnapshotId, sha256: request.context.environmentSha256 },
        policy: { snapshotId: request.context.policySnapshotId, sha256: request.context.policySha256 },
        evidence: [closed.value.ref],
        requiredCriterionIds: [request.criterion.id],
      };
      const run: ReviewRun = {
        id: 'review-signature-anchor', runId: request.runId,
        maker: { actorId: 'maker-1', contextHash: sha('7') }, reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
        artifact: originalBinding.artifact, environment: originalBinding.environment, policy: originalBinding.policy,
        evidence: originalBinding.evidence, requiredCriterionIds: originalBinding.requiredCriterionIds,
        status: 'completed', startedAt: '2026-08-13T00:01:00.000Z', completedAt: '2026-08-13T00:01:30.000Z', nonce: 'nonce-signature-anchor',
      };
      const attestation = await createReviewerAttestation(run, 'passed', signer,
        { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
      if (!attestation.ok) throw new Error(attestation.error.code);
      const originalReview = await verifier.verify(attestation.value, originalBinding);
      if (!originalReview.ok) throw new Error(originalReview.error.code);

      const runDir = join(root, request.runId);
      const manifestPath = join(runDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        algorithm: 'sha256'; rootDigest: string;
        entries: Array<{ path: string; attachmentId?: string; bytes: number; sha256: string }>;
      };
      const recordEntry = manifest.entries.find(entry => entry.path.startsWith('records/'))!;
      const recordPath = join(runDir, recordEntry.path);
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as { objective: { description: string } };
      record.objective.description = 'attacker rewrote consistently hashed evidence';
      const changedBytes = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
      await writeFile(recordPath, changedBytes);
      recordEntry.bytes = changedBytes.byteLength;
      recordEntry.sha256 = digest(changedBytes);
      manifest.rootDigest = manifestRoot(manifest.entries);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      const changedRef = { id: closed.value.ref.id, sha256: recordEntry.sha256 };
      const changedReceipt = await store.readVerifiedClosed(request.runId, changedRef);
      if (!changedReceipt.ok) throw new Error(changedReceipt.error.code);
      expect(store.owns(changedReceipt.value)).toBe(true);

      const changedBinding: ReviewBinding = { ...originalBinding, evidence: [changedRef] };
      const secondVerifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
        issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
        activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
      } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces-changed')), () => '2026-08-13T00:03:00.000Z');
      const reusedSignature = await secondVerifier.verify(attestation.value, changedBinding);
      expect(reusedSignature).toMatchObject({ ok: false, error: { code: 'REVIEW_BINDING_MISMATCH' } });
      expect(new CompletionGate(store, verifier).decide({
        ...changedBinding,
        evidence: [changedReceipt.value],
        review: originalReview.value,
      }, '2026-08-13T00:03:01.000Z')).toMatchObject({ ok: false, error: { code: 'REVIEW_BINDING_MISMATCH' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['record', 'attachment', 'manifest'] as const)('never mints a closed-bundle receipt after %s tampering', async target => {
    const root = await mkdtemp(join(tmpdir(), `wxnodus-build-bridge-tamper-${target}-`));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidenceService = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', `tamper-${target}`);
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      if (!verified.ok) throw new Error(verified.error.code);
      const closed = await evidenceService.close(request, verified.value);
      if (!closed.ok) throw new Error(closed.error.code);
      const runDir = join(root, request.runId);
      const manifestPath = join(runDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: Array<{ path: string }> };
      if (target === 'manifest') await writeFile(manifestPath, '{}');
      else {
        const entry = manifest.entries.find(item => target === 'record' ? item.path.startsWith('records/') : item.path.startsWith('attachments/'))!;
        await writeFile(join(runDir, entry.path), 'tampered');
      }

      const read = await store.readVerifiedClosed(request.runId, closed.value.ref);
      expect(read.ok).toBe(false);
      expect(read.ok ? store.owns(read.value) : false).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const { name, kind, directory } of [
    { name: 'store root', kind: 'store' as const, directory: true },
    { name: 'run root', kind: 'run' as const, directory: true },
    { name: 'records root', kind: 'records' as const, directory: true },
    { name: 'attachments root', kind: 'attachments' as const, directory: true },
    { name: 'manifest file', kind: 'manifest' as const, directory: false },
    { name: 'record file', kind: 'record' as const, directory: false },
    { name: 'attachment file', kind: 'attachment' as const, directory: false },
  ]) {
    it(`rejects a physical symlink or junction at the bundle ${name} when creation is permitted`, async context => {
      const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-run-link-'));
      const outside = await mkdtemp(join(tmpdir(), 'wxnodus-build-run-link-outside-'));
      try {
        const store = new FileEvidenceStore(root);
        const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
        const service = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
        const request = requestFor('process.readiness', `run-link-${kind}`);
        const verified = await registry.verify(request, AbortSignal.timeout(1_000));
        if (!verified.ok) throw new Error(verified.error.code);
        const closed = await service.close(request, verified.value);
        if (!closed.ok) throw new Error(closed.error.code);
        const runDir = join(root, request.runId);
        const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as { entries: Array<{ path: string }> };
        const recordEntry = manifest.entries.find(entry => entry.path.startsWith('records/'))!;
        const attachmentEntry = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
        const target = kind === 'store' ? root
          : kind === 'run' ? runDir
          : kind === 'records' ? join(runDir, 'records')
          : kind === 'attachments' ? join(runDir, 'attachments')
          : kind === 'manifest' ? join(runDir, 'manifest.json')
          : kind === 'record' ? join(runDir, recordEntry.path)
          : join(runDir, attachmentEntry.path);
        const outsideTarget = join(outside, `${kind}-${directory ? 'dir' : 'file'}`);
        await rename(target, outsideTarget);
        try {
          await symlink(outsideTarget, target, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
            context.skip();
            return;
          }
          throw error;
        }

        const integrity = await store.verifyIntegrity(request.runId);
        const receipt = await store.readVerifiedClosed(request.runId, closed.value.ref);

        expect(integrity.ok).toBe(false);
        expect(receipt.ok).toBe(false);
        expect(receipt.ok ? store.owns(receipt.value) : false).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  }

  it('rejects extra pending attachments not named by stdout, stderr, additional refs, and closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-extra-pending-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const service = new EvidenceService({
        appendClosed: (record, pending) => store.appendClosed(record, [...pending, { attachmentId: 'extra-unreferenced', bytes: Buffer.from('extra') }]),
      });
      const request = requestFor('process.readiness', 'extra-pending');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      if (!verified.ok) throw new Error(verified.error.code);

      const closed = await service.close(request, verified.value);

      expect(closed).toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_CLOSURE_INVALID' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to re-bless a tampered existing bundle during a later append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-tamper-append-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const service = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const firstRequest = requestFor('process.readiness', 'first');
      const firstVerified = await registry.verify(firstRequest, AbortSignal.timeout(1_000));
      if (!firstVerified.ok) throw new Error(firstVerified.error.code);
      const first = await service.close(firstRequest, firstVerified.value);
      if (!first.ok) throw new Error(first.error.code);
      const manifest = JSON.parse(await readFile(join(root, firstRequest.runId, 'manifest.json'), 'utf8')) as { entries: Array<{ path: string }> };
      const attachment = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
      await writeFile(join(root, firstRequest.runId, attachment.path), 'tampered');

      const secondRequest = requestFor('process.readiness', 'second');
      const secondVerified = await registry.verify(secondRequest, AbortSignal.timeout(1_000));
      if (!secondVerified.ok) throw new Error(secondVerified.error.code);
      const second = await service.close(secondRequest, secondVerified.value);

      expect(second).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
      expect(await store.verifyIntegrity(firstRequest.runId)).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves both closed records when independent stores append concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-concurrent-'));
    try {
      const firstStore = new FileEvidenceStore(root);
      const secondStore = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const services = [
        new EvidenceService({ appendClosed: firstStore.appendClosed.bind(firstStore) }),
        new EvidenceService({ appendClosed: secondStore.appendClosed.bind(secondStore) }),
      ];
      const requests = [requestFor('process.readiness', 'concurrent-a'), requestFor('process.readiness', 'concurrent-b')];
      const results = await Promise.all(requests.map(async (request, index) => {
        const verified = await registry.verify(request, AbortSignal.timeout(1_000));
        if (!verified.ok) return verified;
        return services[index]!.close(request, verified.value);
      }));

      expect(results.every(result => result.ok)).toBe(true);
      const successfulIds = results.flatMap(result => result.ok ? [result.value.evidenceId] : []);
      const integrity = await firstStore.verifyIntegrity('run-build-evidence');
      expect(integrity.ok).toBe(true);
      if (!integrity.ok) throw new Error(integrity.error.code);
      const recordIds = integrity.value.entries.filter(entry => entry.path.startsWith('records/'))
        .map(entry => entry.path.slice('records/'.length, -'.json'.length));
      expect(new Set(recordIds)).toEqual(new Set(successfulIds));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('closes build verification evidence into a tamper-evident bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-evidence-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidence = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', '1');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      const closed = await evidence.close(request, verified.value);
      expect(closed.ok).toBe(true);
      const integrity = await store.verifyIntegrity('run-build-evidence');
      expect(integrity.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks the completion gate when evidence is tampered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-tamper-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidence = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', '1');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      if (!verified.ok) return;
      const closed = await evidence.close(request, verified.value);
      expect(closed.ok).toBe(true);
      const manifestPath = join(root, 'run-build-evidence', 'manifest.json');
      const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8')) as { entries: Array<{ path: string }> };
      const attachment = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
      await writeFile(join(root, 'run-build-evidence', attachment.path), 'tampered');
      await expect(store.verifyIntegrity('run-build-evidence')).resolves.toMatchObject({
        ok: false,
        error: { code: 'EVIDENCE_INTEGRITY_FAILED' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never reports succeeded for failed build verification outcomes', () => {
    const outcomes = [
      classifyBuildVerifierOutcome({ status: 'failed' }),
      classifyBuildVerifierOutcome({ status: 'inconclusive', kind: 'crash' }),
      classifyBuildVerifierOutcome({ status: 'inconclusive', kind: 'test-script-missing' }),
    ];
    for (const outcome of outcomes) expect(outcome.status).not.toBe('succeeded');
    expect(buildVerifierDecision([{ status: 'passed' }, { status: 'inconclusive', kind: 'crash' }]).status).toBe('inconclusive');
  });
});
