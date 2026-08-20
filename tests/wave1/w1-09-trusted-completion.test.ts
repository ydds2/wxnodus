import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTrustedVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { CompletionGate } from '../../src/domain/quality/completionGate.js';
import type { EvidenceAttachment, EvidenceRecord } from '../../src/domain/quality/evidence.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewerAttestation, type ReviewBinding, type ReviewNonceStore, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';
import { ok, type OperationResult } from '../../src/protocol/results.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string => {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('CANONICAL_VALUE_UNSUPPORTED');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};
const hashCanonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
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
  evidence: [], requiredCriterionIds: ['criterion-1'], status: 'completed', startedAt: '2026-08-13T00:01:00.000Z', completedAt: '2026-08-13T00:01:30.000Z', nonce,
});
const binding = (evidenceRefs: ReviewBinding['evidence']): ReviewBinding => ({ runId: 'run-1', artifact: evidence().artifact,
  environment: { snapshotId: 'env-1', sha256: sha('d') }, policy: { snapshotId: 'policy-1', sha256: sha('f') }, evidence: evidenceRefs,
  requiredCriterionIds: ['criterion-1'] });
function reviewFixture(root: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
    activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')), () => '2026-08-13T00:03:00.000Z');
  return { signer, verifier };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
function verifierWithNonceStore(nonces: ReviewNonceStore) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
    activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, nonces, () => '2026-08-13T00:03:00.000Z');
  return { signer, verifier };
}
async function resignWithRuntimeFields(attestation: ReviewerAttestation, fields: Record<string, unknown>, signer: { sign(hash: Uint8Array): Promise<Uint8Array> }) {
  const { reviewInputHash: _reviewInputHash, signature: _signature, ...unsigned } = attestation;
  const body = { ...unsigned, ...fields };
  const reviewInputHash = hashCanonical(body);
  return {
    ...body,
    reviewInputHash,
    signature: Buffer.from(await signer.sign(Buffer.from(reviewInputHash, 'hex'))).toString('base64'),
  } as unknown as ReviewerAttestation;
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

  it.each([
    { name: 'blank', criteria: [{ ...evidence().criteria[0]!, id: '' }] },
    { name: 'whitespace', criteria: [{ ...evidence().criteria[0]!, id: '   ' }] },
    { name: 'undefined', criteria: [{ ...evidence().criteria[0]!, id: undefined }] },
    { name: 'non-string', criteria: [{ ...evidence().criteria[0]!, id: 1 }] },
    { name: 'blank description', criteria: [{ ...evidence().criteria[0]!, description: '   ' }] },
    { name: 'non-boolean required', criteria: [{ ...evidence().criteria[0]!, required: 'true' }] },
    { name: 'invalid status', criteria: [{ ...evidence().criteria[0]!, status: 'unknown' }] },
    { name: 'sparse', criteria: new Array(1) },
  ])('rejects legacy append with malformed $name criterion shape and never mints an owned receipt', async ({ criteria }) => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-invalid-criterion-write-'));
    try {
      const store = new FileEvidenceStore(root);
      const record = evidence();
      record.criteria = criteria as EvidenceRecord['criteria'];

      const appended = await store.append(record, attachments());
      const readback = appended.ok ? await store.readVerified(appended.value) : undefined;

      expect(appended).toMatchObject({ ok: false, error: { code: 'EVIDENCE_WRITE_FAILED' } });
      expect(readback).toBeUndefined();
      expect(store.owns(readback)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed legacy criterion at readback and never mints ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-invalid-criterion-readback-'));
    try {
      const store = new FileEvidenceStore(root);
      const record = evidence();
      const appended = await store.append(record, attachments());
      if (!appended.ok) throw new Error(appended.error.code);
      const recordPath = join(root, 'records', record.id, 'record.json');
      const malformed = { ...record, criteria: [{ ...record.criteria[0]!, id: '   ' }] };
      const bytes = Buffer.from(JSON.stringify(malformed), 'utf8');
      await (await import('node:fs/promises')).chmod(recordPath, 0o644);
      await (await import('node:fs/promises')).writeFile(recordPath, bytes);
      const forgedRef = { id: record.id, sha256: digest(bytes) };

      const readback = await store.readVerified(forgedRef);

      expect(readback).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
      expect(readback.ok ? store.owns(readback.value) : false).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed criteria on closed bundle write and bundle readback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-invalid-bundle-criterion-'));
    try {
      const store = new FileEvidenceStore(root);
      const malformed = evidence();
      malformed.attachments = [];
      malformed.closure = { status: 'closed', attachmentIds: ['stdout-1', 'stderr-1'] };
      malformed.criteria = [{ ...malformed.criteria[0]!, id: '   ' }];

      expect(await store.appendClosed(malformed, attachments().map(item => ({
        attachmentId: item.attachmentId,
        bytes: Buffer.from(item.content),
      })))).toMatchObject({ ok: false, error: { code: 'EVIDENCE_WRITE_FAILED' } });
      expect(await store.appendBundle({ runId: malformed.runId, records: [malformed], attachments: {} } as never))
        .toMatchObject({ ok: false, error: { code: 'EVIDENCE_WRITE_FAILED' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never mints an owned receipt when a declared extra attachment is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-w1-extra-missing-'));
    try {
      const store = new FileEvidenceStore(root);
      const record = evidence();
      record.attachments = [{
        attachmentId: 'diagnostic-1',
        relativePath: 'logs/diagnostic.bin',
        sha256: digest(Buffer.from('diagnostic', 'utf8')),
        bytes: Buffer.byteLength('diagnostic'),
      }];
      record.closure = { status: 'closed', attachmentIds: ['stdout-1', 'stderr-1', 'diagnostic-1'] };

      const appended = await store.append(record, attachments());
      let receipt: unknown;
      if (appended.ok) {
        const readback = await store.readVerified(appended.value);
        if (readback.ok) receipt = readback.value;
      }

      expect(appended).toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_CLOSURE_INVALID' } });
      expect(receipt).toBeUndefined();
      expect(store.owns(receipt)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an explicit attachment closure that omits a declared reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-w1-closure-mismatch-'));
    try {
      const store = new FileEvidenceStore(root);
      const diagnostic = Buffer.from('diagnostic', 'utf8');
      const record = evidence();
      record.attachments = [{
        attachmentId: 'diagnostic-1',
        relativePath: 'logs/diagnostic.bin',
        sha256: digest(diagnostic),
        bytes: diagnostic.byteLength,
      }];
      record.closure = { status: 'closed', attachmentIds: ['stdout-1', 'stderr-1'] };

      expect(await store.append(record, [...attachments(), {
        attachmentId: 'diagnostic-1', relativePath: 'logs/diagnostic.bin', content: diagnostic,
      }])).toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_CLOSURE_INVALID' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses ownership when a declared extra attachment is missing at readback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-w1-extra-readback-'));
    try {
      const store = new FileEvidenceStore(root);
      const diagnostic = Buffer.from('diagnostic', 'utf8');
      const record = evidence();
      record.attachments = [{
        attachmentId: 'diagnostic-1',
        relativePath: 'logs/diagnostic.bin',
        sha256: digest(diagnostic),
        bytes: diagnostic.byteLength,
      }];
      record.closure = { status: 'closed', attachmentIds: ['stdout-1', 'stderr-1', 'diagnostic-1'] };
      const appended = await store.append(record, [...attachments(), {
        attachmentId: 'diagnostic-1', relativePath: 'logs/diagnostic.bin', content: diagnostic,
      }]);
      if (!appended.ok) throw new Error(appended.error.code);
      await rm(join(root, 'records', record.id, 'attachments', 'logs', 'diagnostic.bin'));

      const readback = await store.readVerified(appended.value);

      expect(readback).toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_MISSING' } });
      expect(store.owns(readback)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('snapshots a plain exact EvidenceRef synchronously and rejects proxy/accessor/custom/toJSON/sparse shapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-evidence-ref-shape-'));
    try {
      const store = new FileEvidenceStore(root);
      const appended = await store.append(evidence(), attachments());
      if (!appended.ok) throw new Error(appended.error.code);
      const accessor = { ...appended.value };
      Object.defineProperty(accessor, 'id', { enumerable: true, get: () => appended.value.id });
      const custom = Object.assign(Object.create({ inherited: true }) as object, appended.value);
      const toJSON = { ...appended.value } as typeof appended.value & { toJSON?: () => unknown };
      Object.defineProperty(toJSON, 'toJSON', { enumerable: false, value: () => appended.value });
      const sparse = Object.assign(new Array(2), { 0: appended.value.id, 1: appended.value.sha256 });
      const proxy = new Proxy({ ...appended.value }, {});

      for (const malformed of [accessor, custom, toJSON, sparse, proxy]) {
        const read = await store.readVerified(malformed as never);
        expect(read).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
        expect(read.ok ? store.owns(read.value) : false).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cannot rebind an EvidenceRef between verification and receipt creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-evidence-ref-rebind-'));
    try {
      const store = new FileEvidenceStore(root);
      const first = await store.append(evidence(), attachments());
      if (!first.ok) throw new Error(first.error.code);
      let idReads = 0;
      let hashReads = 0;
      const rebinding = new Proxy({ ...first.value }, {
        get(target, property, receiver) {
          if (property === 'id' && ++idReads > 3) return 'forged-evidence';
          if (property === 'sha256' && ++hashReads > 2) return sha('0');
          return Reflect.get(target, property, receiver);
        },
      });

      const verified = await store.readVerified(rebinding);

      expect(verified).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
      expect(verified.ok ? store.owns(verified.value) : false).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const { name, kind, directory } of [
    { name: 'store root', kind: 'store' as const, directory: true },
    { name: 'records root', kind: 'records' as const, directory: true },
    { name: 'record root', kind: 'record' as const, directory: true },
    { name: 'record file', kind: 'record-file' as const, directory: false },
    { name: 'attachments root', kind: 'attachments' as const, directory: true },
    { name: 'attachment ancestor', kind: 'attachment-directory' as const, directory: true },
    { name: 'attachment file', kind: 'attachment-file' as const, directory: false },
  ]) {
    it(`rejects a physical symlink or junction at the legacy ${name} when creation is permitted`, async context => {
      const root = await mkdtemp(join(tmpdir(), 'wxnodus-evidence-link-'));
      const outside = await mkdtemp(join(tmpdir(), 'wxnodus-evidence-outside-'));
      try {
        const store = new FileEvidenceStore(root);
        const appended = await store.append(evidence(), attachments());
        if (!appended.ok) throw new Error(appended.error.code);
        const recordDir = join(root, 'records', appended.value.id);
        const target = kind === 'store' ? root
          : kind === 'records' ? join(root, 'records')
          : kind === 'record' ? recordDir
          : kind === 'record-file' ? join(recordDir, 'record.json')
          : kind === 'attachments' ? join(recordDir, 'attachments')
          : kind === 'attachment-directory' ? join(recordDir, 'attachments', 'logs')
          : join(recordDir, 'attachments', 'logs', 'stdout.bin');
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

        const verified = await store.readVerified(appended.value);
        expect(verified.ok).toBe(false);
        expect(verified.ok ? store.owns(verified.value) : false).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  }

  it('verifies canonical bindings/signature/key policy/freshness and rejects replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-review-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
    const attestation = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!attestation.ok) throw new Error(attestation.error.code);
    expect(await verifier.verify(attestation.value, expected)).toMatchObject({ ok: true });
    expect(await verifier.verify(attestation.value, expected))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_REPLAYED' } });
    const forged = { ...attestation.value, signature: Buffer.alloc(64).toString('base64') };
    expect(await reviewFixture(await mkdtemp(join(tmpdir(), 'wxnodus-forged-'))).verifier.verify(forged, expected))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_SIGNATURE_INVALID' } });
    const stale = await createReviewerAttestation({ ...reviewRun('nonce-stale'), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-12T00:05:00.000Z' });
    if (!stale.ok) throw new Error(stale.error.code);
    expect(await reviewFixture(await mkdtemp(join(tmpdir(), 'wxnodus-stale-'))).verifier.verify(stale.value, expected))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_STALE' } });
  });

  it('snapshots attestation and binding before deferred nonce consumption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-review-toctou-'));
    try {
      const store = new FileEvidenceStore(root);
      const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
      const verifiedEvidence = await store.readVerified(ref.value); if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);
      const nonceResult = deferred<OperationResult<void>>();
      let consumedInput: Parameters<ReviewNonceStore['consume']>[0] | undefined;
      const nonces: ReviewNonceStore = { consume: input => { consumedInput = input; return nonceResult.promise; } };
      const { signer, verifier } = verifierWithNonceStore(nonces);
      const expected = binding([ref.value]);
      const signed = await createReviewerAttestation({ ...reviewRun('nonce-toctou'), evidence: [ref.value] }, 'failed', signer,
        { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
      if (!signed.ok) throw new Error(signed.error.code);
      const gateBinding = structuredClone(expected);
      const expectedBindingHash = hashCanonical(gateBinding);

      const verification = verifier.verify(signed.value, expected);
      expect(consumedInput).toMatchObject({ nonce: 'nonce-toctou', reviewInputHash: signed.value.reviewInputHash });

      signed.value.outcome = 'passed';
      signed.value.maker.actorId = 'mutated-maker';
      signed.value.reviewer.actorId = 'mutated-reviewer';
      signed.value.artifact.id = 'mutated-artifact';
      signed.value.evidence[0]!.id = 'mutated-evidence';
      expected.artifact.id = 'mutated-expected-artifact';
      expected.evidence[0]!.id = 'mutated-expected-evidence';
      nonceResult.resolve(ok(undefined));

      const verified = await verification;
      expect(verified).toMatchObject({
        ok: true,
        value: {
          attestation: {
            outcome: 'failed',
            maker: { actorId: 'maker-1' },
            reviewer: { actorId: 'reviewer-1' },
            artifact: { id: 'artifact-1' },
            evidence: [{ id: 'evidence-1' }],
          },
          bindingHash: expectedBindingHash,
        },
      });
      if (!verified.ok) throw new Error(verified.error.code);
      expect(Object.isFrozen(verified.value.attestation.maker)).toBe(true);
      expect(Object.isFrozen(verified.value.attestation.reviewer)).toBe(true);
      const decision = new CompletionGate(store, verifier).decide({
        ...gateBinding,
        requiredCriterionIds: ['criterion-1'],
        evidence: [verifiedEvidence.value],
        review: verified.value,
      }, '2026-08-13T00:03:01.000Z');
      expect(decision).toMatchObject({ ok: true, value: { status: 'failed' } });
      expect(decision).not.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['cancelled', 'unknown'])('rejects signed runtime review outcome %s before consuming its nonce', async outcome => {
    let consumeCalls = 0;
    const nonces: ReviewNonceStore = { consume: async () => { consumeCalls += 1; return ok(undefined); } };
    const { signer, verifier } = verifierWithNonceStore(nonces);
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun(`nonce-${outcome}`), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);
    const runtimeAttestation = await resignWithRuntimeFields(signed.value, { outcome }, signer);

    const result = await verifier.verify(runtimeAttestation, expected);

    expect(result).toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_INVALID' } });
    expect(consumeCalls).toBe(0);
    expect(result.ok ? verifier.owns(result.value) : false).toBe(false);
  });

  it('rejects a signed unsupported schema version before consuming its nonce', async () => {
    let consumeCalls = 0;
    const nonces: ReviewNonceStore = { consume: async () => { consumeCalls += 1; return ok(undefined); } };
    const { signer, verifier } = verifierWithNonceStore(nonces);
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun('nonce-schema'), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);
    const runtimeAttestation = await resignWithRuntimeFields(signed.value, { schemaVersion: 3 }, signer);

    const result = await verifier.verify(runtimeAttestation, expected);

    expect(result).toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_INVALID' } });
    expect(consumeCalls).toBe(0);
    expect(result.ok ? verifier.owns(result.value) : false).toBe(false);
  });

  it('still verifies a historical v1 signature but never lets it authorize completion', async () => {
    let consumeCalls = 0;
    const nonces: ReviewNonceStore = { consume: async () => { consumeCalls += 1; return ok(undefined); } };
    const { signer, verifier } = verifierWithNonceStore(nonces);
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun('nonce-v1'), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);
    const runtimeAttestation = await resignWithRuntimeFields(signed.value, { schemaVersion: 1 }, signer);

    const result = await verifier.verify(runtimeAttestation, expected);

    expect(result).toMatchObject({ ok: true, value: { attestation: { schemaVersion: 1 } } });
    expect(consumeCalls).toBe(1);
    expect(result.ok ? verifier.owns(result.value) : false).toBe(true);
  });

  it('rejects uncloneable attestation input without consuming its nonce', async () => {
    let consumeCalls = 0;
    const nonces: ReviewNonceStore = { consume: async () => { consumeCalls += 1; return ok(undefined); } };
    const { signer, verifier } = verifierWithNonceStore(nonces);
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun('nonce-uncloneable'), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);
    Object.defineProperty(signed.value, 'uncloneable', { enumerable: true, value: () => undefined });

    const result = await verifier.verify(signed.value, expected);

    expect(result).toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_INVALID' } });
    expect(consumeCalls).toBe(0);
    expect(result.ok ? verifier.owns(result.value) : false).toBe(false);
  });

  it.each([
    { name: 'extra trusted field', prepare: (attestation: ReviewerAttestation) => ({ ...attestation, trusted: true }) },
    { name: 'arbitrary extra field', prepare: (attestation: ReviewerAttestation) => ({ ...attestation, arbitrary: 'unsigned' }) },
    { name: 'cyclic extra field', prepare: (attestation: ReviewerAttestation) => {
      const runtime = { ...attestation } as ReviewerAttestation & { extra?: unknown };
      runtime.extra = runtime;
      return runtime;
    } },
    { name: 'custom prototype', prepare: (attestation: ReviewerAttestation) => Object.assign(Object.create({ inherited: true }) as object, attestation) },
    { name: 'prototype toJSON', prepare: (attestation: ReviewerAttestation) => Object.assign(Object.create({ toJSON: () => attestation }) as object, attestation) },
    { name: 'own accessor', prepare: (attestation: ReviewerAttestation) => {
      const runtime = { ...attestation } as ReviewerAttestation;
      Object.defineProperty(runtime, 'issuer', { enumerable: true, get: () => attestation.issuer });
      return runtime;
    } },
    { name: 'nested extra field', prepare: (attestation: ReviewerAttestation) => ({
      ...attestation,
      artifact: { ...attestation.artifact, extra: true },
    }) },
    { name: 'nested custom prototype', prepare: (attestation: ReviewerAttestation) => ({
      ...attestation,
      maker: Object.assign(Object.create({ inherited: true }) as object, attestation.maker),
    }) },
    { name: 'nested accessor', prepare: (attestation: ReviewerAttestation) => {
      const environment = { ...attestation.environment };
      Object.defineProperty(environment, 'snapshotId', { enumerable: true, get: () => attestation.environment.snapshotId });
      return { ...attestation, environment };
    } },
  ])('rejects reviewer attestation with $name before nonce consumption or receipt ownership', async ({ prepare }) => {
    const consume = vi.fn(async () => ok(undefined));
    const { signer, verifier } = verifierWithNonceStore({ consume });
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun(`nonce-${Date.now()}`), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);

    const result = await verifier.verify(prepare(signed.value) as ReviewerAttestation, expected);

    expect(result).toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_INVALID' } });
    expect(consume).not.toHaveBeenCalled();
    expect(result.ok ? verifier.owns(result.value) : false).toBe(false);
  });

  it.each([
    { name: 'extra binding field', prepare: (expected: ReviewBinding) => ({ ...expected, extra: true }) },
    { name: 'sparse evidence refs', prepare: (expected: ReviewBinding) => ({ ...expected, evidence: new Array(1) }) },
    { name: 'accessor binding', prepare: (expected: ReviewBinding) => {
      const runtime = { ...expected } as ReviewBinding;
      Object.defineProperty(runtime, 'runId', { enumerable: true, get: () => expected.runId });
      return runtime;
    } },
  ])('rejects review binding with $name before nonce consumption', async ({ prepare }) => {
    const consume = vi.fn(async () => ok(undefined));
    const { signer, verifier } = verifierWithNonceStore({ consume });
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun('nonce-invalid-binding'), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);

    const result = await verifier.verify(signed.value, prepare(expected) as ReviewBinding);

    expect(result).toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_INVALID' } });
    expect(consume).not.toHaveBeenCalled();
    expect(result.ok ? verifier.owns(result.value) : false).toBe(false);
  });

  it('returns a frozen receipt containing exactly the signed attestation fields', async () => {
    const { signer, verifier } = verifierWithNonceStore({ consume: async () => ok(undefined) });
    const expected = binding([{ id: 'evidence-1', sha256: sha('a') }]);
    const signed = await createReviewerAttestation({ ...reviewRun('nonce-exact-candidate'), evidence: expected.evidence }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);

    const verified = await verifier.verify(signed.value, expected);

    expect(verified).toMatchObject({ ok: true });
    if (!verified.ok) throw new Error(verified.error.code);
    expect(Object.keys(verified.value.attestation).sort()).toEqual([
      'artifact', 'environment', 'evidence', 'expiresAt', 'issuedAt', 'issuer', 'keyId', 'maker', 'nonce', 'outcome',
      'policy', 'requiredCriterionIds', 'reviewInputHash', 'reviewRunId', 'reviewer', 'runId', 'schemaVersion', 'signature',
    ].sort());
    expect(Object.isFrozen(verified.value)).toBe(true);
    expect(Object.isFrozen(verified.value.attestation)).toBe(true);
    expect(verified.value.attestation).not.toHaveProperty('trusted');
  });

  it('issues a detached deeply immutable reviewer receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-review-immutable-'));
    try {
      const store = new FileEvidenceStore(root);
      const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
      const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
      const signed = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
        { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
      if (!signed.ok) throw new Error(signed.error.code);
      const verified = await verifier.verify(signed.value, expected);
      if (!verified.ok) throw new Error(verified.error.code);

      expect(verifier.owns(verified.value)).toBe(true);
      expect(verified.value.attestation).not.toBe(signed.value);
      expect(Object.isFrozen(verified.value.attestation)).toBe(true);
      expect(Object.isFrozen(verified.value.attestation.reviewer)).toBe(true);
      expect(Object.isFrozen(verified.value.attestation.artifact)).toBe(true);
      expect(Object.isFrozen(verified.value.attestation.evidence)).toBe(true);
      expect(Object.isFrozen(verified.value.attestation.evidence[0])).toBe(true);

      signed.value.reviewer.actorId = 'source-mutated';
      signed.value.artifact.id = 'source-mutated';
      signed.value.evidence[0]!.id = 'source-mutated';
      expect(verified.value.attestation).toMatchObject({
        reviewer: { actorId: 'reviewer-1' },
        artifact: { id: 'artifact-1' },
        evidence: [{ id: 'evidence-1' }],
      });
      expect(() => {
        (verified.value.attestation as unknown as { reviewer: { actorId: string } }).reviewer.actorId = 'forged';
      }).toThrow(TypeError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CompletionGate rejects forged trusted objects and accepts only verifier-owned receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-gate-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    const verifiedEvidence = await store.readVerified(ref.value); if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);
    const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
    const signed = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' }); if (!signed.ok) throw new Error(signed.error.code);
    const review = await verifier.verify(signed.value, expected); if (!review.ok) throw new Error(review.error.code);
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
