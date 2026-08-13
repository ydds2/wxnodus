// tests/integration/wave3-current-migration-recovery.test.ts — W3-11：当前候选 recovery drill（Gate C-W3 契约）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWave3RecoveryDrill } from '../../scripts/drill-wave3-recovery.mjs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let root: string;

const artifact = Buffer.from('wxnodus-wave3-candidate');
const binding = {
  runId: 'run-w3-c',
  candidateCommit: 'commit-w3-candidate',
  artifactId: 'artifact-w3',
  artifactSha256: sha256(artifact),
  environmentSnapshotId: 'env-w3',
};

const passDescriptor = {
  id: 'config-rollbackable',
  strategy: 'rollbackable' as const,
  hash: sha256(Buffer.from('config-rollbackable')),
  drill: () => ({ ok: true as const, evidenceId: 'ev-config' }),
};
const failDescriptor = {
  id: 'db-forward-only',
  strategy: 'forward-only' as const,
  hash: sha256(Buffer.from('db-forward-only')),
  drill: () => ({ ok: false as const, stage: 'reconcile', cause: 'injected' }),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wxnodus-w3-drill-'));
  writeFileSync(join(root, 'candidate-artifact.bin'), artifact);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('wave3 current migration recovery', () => {
  it('produces a closed current-candidate receipt binding runId/commit/artifact/environment', () => {
    const result = runWave3RecoveryDrill({ root, ...binding, descriptors: [passDescriptor], maxRtoMs: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.receiptPath)).toBe(true);
    expect(result.receipt).toMatchObject({
      receiptId: `c-w3-${binding.runId}`,
      runId: binding.runId,
      candidateCommit: binding.candidateCommit,
      artifact: { id: binding.artifactId, sha256: binding.artifactSha256 },
      environmentSnapshotId: binding.environmentSnapshotId,
      closure: { status: 'closed' },
    });
    expect(result.receipt.stages).toMatchObject([{ descriptorId: 'config-rollbackable', ok: true }]);
  });

  it('rejects artifact hash drift with WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH', () => {
    writeFileSync(join(root, 'candidate-artifact.bin'), Buffer.from('drifted'));
    expect(runWave3RecoveryDrill({ root, ...binding, descriptors: [passDescriptor] })).toMatchObject({
      ok: false,
      error: { code: 'WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH' },
    });
  });

  it('fails the drill with WAVE3_RECOVERY_DRILL_FAILED when a descriptor stage fails', () => {
    expect(runWave3RecoveryDrill({ root, ...binding, descriptors: [passDescriptor, failDescriptor] })).toMatchObject({
      ok: false,
      error: { code: 'WAVE3_RECOVERY_DRILL_FAILED', stage: 'db-forward-only:reconcile' },
    });
  });

  it('enforces maxRtoMs per descriptor', () => {
    const slowDescriptor = {
      id: 'slow',
      strategy: 'rollbackable' as const,
      hash: sha256(Buffer.from('slow')),
      drill: () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 30) { /* 忙等越过 maxRto */ }
        return { ok: true as const };
      },
    };
    expect(runWave3RecoveryDrill({ root, ...binding, descriptors: [slowDescriptor], maxRtoMs: 5 })).toMatchObject({
      ok: false,
      error: { code: 'WAVE3_RECOVERY_DRILL_FAILED', stage: 'slow:max-rto' },
    });
  });

  it('refuses to run without a full binding', () => {
    expect(runWave3RecoveryDrill({ root, runId: '', candidateCommit: '', artifactId: '', artifactSha256: '', environmentSnapshotId: '', descriptors: [] })).toMatchObject({
      ok: false,
      error: { code: 'WAVE3_CURRENT_MIGRATION_RECEIPT_MISSING' },
    });
  });

  it('is byte-deterministic for the same inputs modulo timestamps', () => {
    const first = runWave3RecoveryDrill({ root, ...binding, descriptors: [passDescriptor] });
    const second = runWave3RecoveryDrill({ root, ...binding, descriptors: [passDescriptor] });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.receipt.stages.map(stage => stage.descriptorId)).toEqual(second.receipt.stages.map(stage => stage.descriptorId));
    expect(first.receipt.descriptorHashes).toEqual(second.receipt.descriptorHashes);
  });
});
