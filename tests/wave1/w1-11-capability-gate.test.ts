// tests/wave1/w1-11-capability-gate.test.ts — Wave 1 能力围栏 + Gate 可信边界 + 迁移演练
// 注：W1-09 最终信任边界删除了一切 trusted: boolean 字段——Gate 只接受 FileEvidenceStore /
// ReviewerAttestationVerifier 实例签发的 receipt（WeakSet 身份判定），本测试按该合同落地。
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Wave1CapabilityRegistry } from '../../src/application/capabilities/capabilityRegistry.js';
import type { CapabilityPort } from '../../src/domain/capabilities/capability.js';
import { evaluateWave1Gates } from '../../src/release/gateDefinitions.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';
import type { EvidenceAttachment, EvidenceRecord } from '../../src/domain/quality/evidence.js';

const unavailable = ['voice', 'computer', 'forge', 'distribution'] as const;
const sha = (c: string) => c.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8');
const attachments: EvidenceAttachment[] = [
  { attachmentId: 'stdout', relativePath: 'logs/stdout.bin', content: stdout },
  { attachmentId: 'stderr', relativePath: 'logs/stderr.bin', content: Buffer.alloc(0) },
];
const artifact = { id: 'artifact-1', sha256: sha('3'), commitSha: '1'.repeat(40) };
const environment = { snapshotId: 'env-1', sha256: sha('4') };
const policy = { snapshotId: 'policy-1', sha256: sha('5') };
const record = (): EvidenceRecord => ({
  id: 'gate-evidence-1', schemaVersion: 1, runId: 'gate-wave1', createdAt: '2026-08-13T00:00:00.000Z',
  objective: { id: 'gate-g', description: 'trusted completion' },
  criteria: [{ id: 'gate-g', description: 'trusted completion', required: true, expected: true, observed: true, status: 'passed' }],
  command: { executable: 'npm.cmd', argv: ['run', 'test:w1-11'], cwd: 'C:/workspace', normalized: 'npm.cmd run test:w1-11', timeoutMs: 60_000 },
  exit: { code: 0, signal: null, timedOut: false, aborted: false },
  stdout: { attachmentId: 'stdout', relativePath: 'logs/stdout.bin', sha256: digest(stdout), bytes: stdout.byteLength },
  stderr: { attachmentId: 'stderr', relativePath: 'logs/stderr.bin', sha256: digest(Buffer.alloc(0)), bytes: 0 },
  artifact, environment: { ...environment, platform: 'win32', arch: 'x64' },
  capability: { snapshotId: 'cap-1', sha256: sha('c'), requiredIds: ['command'] },
  policy: { ...policy, decisionId: 'decision-1' },
  verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: sha('d'), status: 'passed' },
  correlation: { correlationId: 'corr-1', traceId: 'trace-1' },
  lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] },
  authority: { source: 'process-supervisor', sourceRecordId: 'proc-1', sourceStatus: 'passed' },
});
const reviewRun = (): ReviewRun => ({
  id: 'review-1', runId: 'gate-wave1', maker: { actorId: 'maker-1', contextHash: sha('1') },
  reviewer: { actorId: 'reviewer-1', contextHash: sha('2') }, artifact, environment, policy,
  evidence: [], status: 'completed', startedAt: '2026-08-13T00:01:00.000Z', completedAt: '2026-08-13T00:01:30.000Z', nonce: 'nonce-gate',
});
function reviewFixture(root: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'],
    activeFrom: '2026-08-01T00:00:00.000Z', activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')));
  return { signer, verifier };
}

describe('W1-11 capability and gate boundary', () => {
  it('implements the W1-02 CapabilityPort and fences undelivered capabilities at every adapter', () => {
    const registry: CapabilityPort = new Wave1CapabilityRegistry('policy-1', () => '2026-08-13T00:00:00.000Z');
    for (const id of unavailable) expect(registry.require(id)).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    expect(registry.require('command')).toMatchObject({ ok: true });
  });

  it('Gate G accepts only integrity-checked Evidence and verifier-owned review receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-wave1-gate-'));
    const store = new FileEvidenceStore(root);
    const ref = await store.append(record(), attachments); if (!ref.ok) throw new Error(ref.error.code);
    const trusted = await store.readVerified(ref.value); if (!trusted.ok) throw new Error(trusted.error.code);

    const { signer, verifier } = reviewFixture(root);
    const binding: ReviewBinding = { runId: 'gate-wave1', artifact, environment, policy, evidence: [ref.value] };
    const signed = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!signed.ok) throw new Error(signed.error.code);
    const reviewer = await verifier.verify(signed.value, binding, '2026-08-13T00:03:00.000Z');
    if (!reviewer.ok) throw new Error(reviewer.error.code);

    const gates = evaluateWave1Gates([{ id: 'G', required: true, evidence: [trusted.value], reviewer: reviewer.value }], { evidenceStore: store, reviewerVerifier: verifier });
    expect(gates).toMatchObject({ ok: true, value: { passed: true } });
    // spread 拷贝不是 store 拥有的 receipt → 必须 GATE_EVIDENCE_UNTRUSTED（无法伪造 trusted:true）
    expect(evaluateWave1Gates([{ id: 'G', required: true, evidence: [{ ...trusted.value, trusted: true }] as never, reviewer: reviewer.value }], { evidenceStore: store, reviewerVerifier: verifier }))
      .toMatchObject({ ok: false, error: { code: 'GATE_EVIDENCE_UNTRUSTED' } });
    // review 伪造（自报对象）→ GATE_REVIEW_UNTRUSTED
    expect(evaluateWave1Gates([{ id: 'G', required: true, evidence: [trusted.value], reviewer: { trusted: true, attestation: signed.value } as never }], { evidenceStore: store, reviewerVerifier: verifier }))
      .toMatchObject({ ok: false, error: { code: 'GATE_REVIEW_UNTRUSTED' } });
    // 落盘篡改 → 完整性失败（不可变存储检测）
    await chmod(join(root, 'records', ref.value.id, 'record.json'), 0o644);
    await writeFile(join(root, 'records', ref.value.id, 'record.json'), '{}');
    expect(await store.readVerified(ref.value)).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
  });

  it('requires the Wave migration drill order for rollbackable and forward-only descriptors', async () => {
    const { runWaveMigrationDrill } = await import('../../scripts/run-wave1-migration-drill.mjs');
    const forward: string[] = [];
    expect(await runWaveMigrationDrill({ id: 'w1-security', strategy: 'forward-only' as const,
      upgrade: vi.fn(async () => { forward.push('upgrade'); }), confirmNewWrite: vi.fn(async () => { forward.push('new-write'); }),
      reconcile: vi.fn(async () => { forward.push('forward-reconcile'); }), reupgrade: vi.fn(async () => { forward.push('re-upgrade'); }) })).toEqual({ ok: true });
    expect(forward).toEqual(['upgrade', 'new-write', 'forward-reconcile', 're-upgrade']);
    const rollbackable: string[] = [];
    expect(await runWaveMigrationDrill({ id: 'w1-config', strategy: 'rollbackable' as const,
      upgrade: vi.fn(async () => { rollbackable.push('upgrade'); }), confirmNewWrite: vi.fn(async () => { rollbackable.push('new-write'); }),
      rollback: vi.fn(async () => { rollbackable.push('rollback'); }), reupgrade: vi.fn(async () => { rollbackable.push('re-upgrade'); }) })).toEqual({ ok: true });
    expect(rollbackable).toEqual(['upgrade', 'new-write', 'rollback', 're-upgrade']);
  });
});
