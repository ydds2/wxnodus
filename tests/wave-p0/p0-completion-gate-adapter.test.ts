// tests/wave-p0/p0-completion-gate-adapter.test.ts — W0-01：gate:completion 脚本必须是 TS authority 的薄 adapter
// 只验证 orchestration：owned succeeded receipt → 0；缺失 persisted input / 篡改 / 缺 reviewer trust → blocked。
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCompletionGate } from '../../src/cli/runCompletionGate.js';
import { EvidenceService } from '../../src/application/quality/evidenceService.js';
import { createBuiltinVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../src/domain/quality/verifier.js';
import type { VerificationRequest } from '../../src/domain/quality/verifier.js';
import { createReviewerAttestation, type ReviewBinding, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';

const sha = (char: string) => char.repeat(64);

const requestFor = (verifierId: 'process.readiness', attempt: string): VerificationRequest => ({
  id: `v-${attempt}`,
  runId: 'run-completion-adapter',
  objective: { id: 'o1', description: 'completion adapter' },
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

async function fixture(attempt: string) {
  const root = await mkdtemp(join(tmpdir(), 'wxnodus-completion-adapter-'));
  const evidenceRoot = join(root, 'release-evidence');
  const store = new FileEvidenceStore(evidenceRoot);
  const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
  const evidenceService = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
  const request = requestFor('process.readiness', attempt);
  const verified = await registry.verify(request, AbortSignal.timeout(1_000));
  if (!verified.ok) throw new Error(verified.error.code);
  const closed = await evidenceService.close(request, verified.value);
  if (!closed.ok) throw new Error(closed.error.code);
  const receipt = await store.readVerifiedClosed(request.runId, closed.value.ref);
  if (!receipt.ok) throw new Error(receipt.error.code);
  const record = receipt.value.record;

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const binding: ReviewBinding = {
    runId: record.runId,
    artifact: record.artifact,
    environment: { snapshotId: record.environment.snapshotId, sha256: record.environment.sha256 },
    policy: { snapshotId: record.policy.snapshotId, sha256: record.policy.sha256 },
    evidence: [closed.value.ref],
    requiredCriterionIds: [request.criterion.id],
  };
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 3_600_000).toISOString();
  const run: ReviewRun = {
    id: 'review-adapter', runId: record.runId,
    maker: { actorId: 'maker-1', contextHash: sha('7') },
    reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
    artifact: binding.artifact, environment: binding.environment, policy: binding.policy,
    evidence: binding.evidence, requiredCriterionIds: binding.requiredCriterionIds,
    status: 'completed', startedAt: new Date(now - 120_000).toISOString(), completedAt: new Date(now - 90_000).toISOString(),
    nonce: `nonce-${attempt}`,
  };
  const attestation = await createReviewerAttestation(run, 'passed', signer, { issuedAt, expiresAt });
  if (!attestation.ok) throw new Error(attestation.error.code);
  const runDir = join(evidenceRoot, request.runId);
  await writeFile(join(runDir, 'completion-input.json'), JSON.stringify({ binding, attestation: attestation.value }, null, 2));
  await writeFile(join(evidenceRoot, 'reviewer-trust.json'), JSON.stringify([{
    issuer: signer.issuer, keyId: signer.keyId, algorithm: 'Ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    reviewerActorIds: ['reviewer-1'],
    activeFrom: new Date(now - 3_600_000).toISOString(), activeUntil: new Date(now + 3_600_000).toISOString(),
    maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  }], null, 2));
  return { root, evidenceRoot, runId: request.runId, runDir, criterionId: request.criterion.id };
}

describe('completion gate adapter', () => {
  it('routes a genuine closed bundle through the authority chain to exit 0', async () => {
    const f = await fixture('adapter-ok');
    try {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const exit = await runCompletionGate(['--run', f.runId, '--evidence-root', f.evidenceRoot]);
        expect(exit).toBe(0);
        expect(stdout).toHaveBeenCalled();
        const decisionLine = stdout.mock.calls.map(call => call.join('')).join('');
        expect(JSON.parse(decisionLine)).toMatchObject({
          status: 'succeeded',
          runId: f.runId,
          evidenceIds: [expect.any(String)],
        });
      } finally {
        stdout.mockRestore();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('blocks without persisted completion input and never falls back to local criteria', async () => {
    const f = await fixture('adapter-missing-input');
    try {
      await rm(join(f.runDir, 'completion-input.json'));
      expect(await runCompletionGate(['--run', f.runId, '--evidence-root', f.evidenceRoot])).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('blocks without reviewer trust configuration', async () => {
    const f = await fixture('adapter-missing-trust');
    try {
      await rm(join(f.evidenceRoot, 'reviewer-trust.json'));
      expect(await runCompletionGate(['--run', f.runId, '--evidence-root', f.evidenceRoot])).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('blocks on tampered evidence and cannot exit 0', async () => {
    const f = await fixture('adapter-tampered');
    try {
      const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(f.runDir, 'manifest.json'), 'utf8')) as {
        entries: Array<{ path: string }>;
      };
      const attachment = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
      await writeFile(join(f.runDir, attachment.path), 'tampered');
      expect(await runCompletionGate(['--run', f.runId, '--evidence-root', f.evidenceRoot])).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('reports incomplete when no run id is supplied', async () => {
    expect(await runCompletionGate([])).toBe(3);
  });
});
