// tests/integration/buildRestartReadback.test.ts — W3-08 Step 1：重启读回契约（计划原文）
import { expect, it, vi } from 'vitest';
import { BuildVerificationCoordinator } from '../../src/application/build/buildVerificationCoordinator.js';

it('writes data, proves stop and port release, starts a new process, and reads the same data back', async () => {
  const events: string[] = [];
  let pid = 100;
  const runtime = {
    start: vi.fn(async () => ({ processId: ++pid, port: 43123, stdoutRef: `stdout-${pid}`, stderrRef: `stderr-${pid}` })),
    ready: vi.fn(async (processId: number) => { events.push(`ready:${processId}`); return true; }),
    stopTree: vi.fn(async (processId: number) => { events.push(`stop:${processId}`); return true; }),
    portReleased: vi.fn(async () => { events.push('port-released'); return true; }),
  };
  const persistence = {
    seed: vi.fn(async () => ({ token: 'row-7', expected: { name: 'persisted' } })),
    readBack: vi.fn(async () => ({ name: 'persisted' })),
  };
  const coordinator = new BuildVerificationCoordinator(runtime, persistence);
  const result = await coordinator.verifyRestart({ runId: 'run-build', artifactHash: 'a'.repeat(64), verificationId: 'verification-1' }, AbortSignal.timeout(1_000));

  expect(result).toMatchObject({ ok: true, value: { firstProcessId: 101, secondProcessId: 102 } });
  expect(events).toEqual(['ready:101', 'stop:101', 'port-released', 'ready:102']);
  expect(persistence.readBack).toHaveBeenCalledWith(102, { token: 'row-7', expected: { name: 'persisted' } }, expect.any(AbortSignal));
});

it('rejects an old process reused by the second probe', async () => {
  const runtime = {
    start: vi.fn(async () => ({ processId: 100, port: 43123, stdoutRef: 'o', stderrRef: 'e' })),
    ready: vi.fn(async () => true),
    stopTree: vi.fn(async () => true),
    portReleased: vi.fn(async () => true),
  };
  const persistence = { seed: vi.fn(async () => ({ token: 't', expected: 1 })), readBack: vi.fn(async () => 1) };
  await expect(new BuildVerificationCoordinator(runtime, persistence).verifyRestart({
    runId: 'r', artifactHash: 'b'.repeat(64), verificationId: 'v',
  }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    ok: false,
    error: { code: 'BUILD_RESTART_REUSED_OLD_PROCESS' },
  });
});
