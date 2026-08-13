// tests/failure/buildVerifierFailure.test.ts — W3-08：verifier 失败/崩溃/快照漂移/读回不一致 → 稳定码（绝不判 succeeded）
import { describe, expect, it, vi } from 'vitest';
import { BuildVerificationCoordinator } from '../../src/application/build/buildVerificationCoordinator.js';
import { classifyBuildVerifierOutcome, buildVerifierDecision } from '../../src/application/quality/buildVerifiers.js';
import { assertSnapshotMatch, createBuildVerificationSnapshot } from '../../src/domain/build/buildRun.js';

describe('build verifier failures', () => {
  it('classifies missing test script, assertion failure, and crash into the right terminal statuses', () => {
    expect(classifyBuildVerifierOutcome({ status: 'passed' })).toEqual({ status: 'succeeded', code: 'BUILD_VERIFIER_PASSED' });
    expect(classifyBuildVerifierOutcome({ status: 'inconclusive', kind: 'test-script-missing' })).toEqual({ status: 'incomplete', code: 'BUILD_TEST_SCRIPT_MISSING' });
    expect(classifyBuildVerifierOutcome({ status: 'inconclusive', kind: 'crash' })).toEqual({ status: 'inconclusive', code: 'BUILD_VERIFIER_INCONCLUSIVE' });
    expect(classifyBuildVerifierOutcome({ status: 'failed' })).toEqual({ status: 'failed', code: 'BUILD_VERIFIER_FAILED' });
    expect(buildVerifierDecision([{ status: 'passed' }, { status: 'inconclusive', kind: 'test-script-missing' }])).toEqual({ status: 'incomplete', code: 'BUILD_TEST_SCRIPT_MISSING' });
    expect(buildVerifierDecision([{ status: 'passed' }, { status: 'failed' }])).toEqual({ status: 'failed', code: 'BUILD_VERIFIER_FAILED' });
  });

  it('detects verification snapshot drift with BUILD_VERIFICATION_SNAPSHOT_MISMATCH', () => {
    const snapshot = createBuildVerificationSnapshot({
      runId: 'r1', artifactHash: 'a'.repeat(64), environmentSnapshotId: 'e', capabilitySnapshotId: 'c', policySnapshotId: 'p',
    });
    expect(assertSnapshotMatch(snapshot, snapshot)).toMatchObject({ ok: true });
    expect(assertSnapshotMatch(snapshot, { artifactHash: 'b'.repeat(64) })).toMatchObject({
      ok: false,
      error: { code: 'BUILD_VERIFICATION_SNAPSHOT_MISMATCH' },
    });
  });

  const cases: Array<[string, { ready?: boolean; stopTree?: boolean; portReleased?: boolean }, string]> = [
    ['not ready', { ready: false }, 'BUILD_PROCESS_NOT_READY'],
    ['did not stop', { stopTree: false }, 'BUILD_PROCESS_DID_NOT_STOP'],
    ['port not released', { portReleased: false }, 'BUILD_PORT_NOT_RELEASED'],
  ];
  for (const [name, patch, code] of cases) {
    it(`maps ${name} to a stable code`, async () => {
      const runtime = {
        start: vi.fn(async () => ({ processId: 10, port: 1234, stdoutRef: 'o', stderrRef: 'e' })),
        ready: vi.fn(async () => patch.ready ?? true),
        stopTree: vi.fn(async () => patch.stopTree ?? true),
        portReleased: vi.fn(async () => patch.portReleased ?? true),
      };
      const persistence = { seed: vi.fn(async () => ({ token: 't', expected: 1 })), readBack: vi.fn(async () => 1) };
      const result = await new BuildVerificationCoordinator(runtime, persistence).verifyRestart(
        { runId: 'r', artifactHash: 'c'.repeat(64), verificationId: 'v' }, AbortSignal.timeout(1_000));
      expect(result).toMatchObject({ ok: false, error: { code } });
    });
  }

  it('maps business read-back mismatch to BUILD_READBACK_MISMATCH', async () => {
    let n = 0;
    const runtime = {
      start: vi.fn(async () => ({ processId: ++n, port: 1234, stdoutRef: 'o', stderrRef: 'e' })),
      ready: vi.fn(async () => true),
      stopTree: vi.fn(async () => true),
      portReleased: vi.fn(async () => true),
    };
    const persistence = { seed: vi.fn(async () => ({ token: 't', expected: { name: 'expected' } })), readBack: vi.fn(async () => ({ name: 'different' })) };
    const result = await new BuildVerificationCoordinator(runtime, persistence).verifyRestart(
      { runId: 'r', artifactHash: 'd'.repeat(64), verificationId: 'v' }, AbortSignal.timeout(1_000));
    expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_READBACK_MISMATCH' } });
  });
});
