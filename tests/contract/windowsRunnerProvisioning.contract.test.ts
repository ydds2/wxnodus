// tests/contract/windowsRunnerProvisioning.contract.test.ts — W3-10 Step 1：受控 Windows runner 契约（计划原文）
import { describe, expect, it } from 'vitest';
import { aggregateGateEReceipts, evaluateWindowsRunner } from '../../src/release/windowsAcceptanceContract.mjs';

const healthy = {
  selfHosted: true,
  labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win11-24h2'],
  interactive: true,
  unlocked: true,
  inputDesktop: 'Default',
  sessionId: 2,
  os: { family: 'win11' as const, version: '10.0.26100' },
  node: { version: '22.14.0', arch: 'x64' as const },
  candidateCommit: 'commit-w3-candidate',
  artifact: { id: 'artifact-w3', sha256: 'a'.repeat(64) },
  environment: { snapshotId: 'env-win11', sha256: 'b'.repeat(64) },
  capability: { snapshotId: 'cap-win11', sha256: 'c'.repeat(64) },
  microphones: [{ id: 'mmdevice-1', active: true, physical: true }],
  sapiVoices: ['Microsoft Huihui Desktop'],
  sapiPlaybackPassed: true,
  fixtures: { lockSha256: 'd'.repeat(64), sourceHashesValid: true, artifactHashesValid: true },
  monitors: [
    { id: 'left', x: -1920, y: 0, width: 1920, height: 1080, scale: 1, physical: true },
    { id: 'main', x: 0, y: 0, width: 2560, height: 1440, scale: 1.5, physical: true },
  ],
};

const receipt = (receiptKey: 'windows-11-24h2-production-real' | 'windows-10-22h2-legacy-compatibility', patch = {}) => ({
  receiptId: `receipt-${receiptKey}`,
  receiptKey,
  runId: 'run-w3-e',
  candidateCommit: healthy.candidateCommit,
  artifact: healthy.artifact,
  environment: healthy.environment,
  capability: healthy.capability,
  runner: healthy,
  fixtures: healthy.fixtures,
  scenarios: [{ id: 'preflight', status: 'passed' as const, attachmentIds: ['scenario-preflight'] }],
  closure: { status: 'closed' as const },
  manifestSha256: 'e'.repeat(64),
  ...patch,
});

describe('controlled Windows runner', () => {
  it('accepts the required physical Win11 shape', () => {
    expect(evaluateWindowsRunner(healthy)).toEqual({ status: 'passed' });
  });

  it.each([
    ['microphone', { microphones: [] }],
    ['SAPI', { sapiVoices: [] }],
    ['second monitor', { monitors: healthy.monitors.slice(1) }],
    ['negative origin', { monitors: healthy.monitors.map(monitor => ({ ...monitor, x: Math.max(0, monitor.x) })) }],
    ['mixed DPI', { monitors: healthy.monitors.map(monitor => ({ ...monitor, scale: 1 })) }],
  ])('blocks Gate E when %s is missing', (_name, patch) => {
    expect(evaluateWindowsRunner({ ...healthy, ...patch })).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED',
    });
  });

  it('accepts controlled Win10 22H2 only as legacy compatibility', () => {
    expect(evaluateWindowsRunner({
      ...healthy,
      labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win10-22h2'],
      os: { family: 'win10', version: '10.0.19045' },
    })).toEqual({ status: 'passed' });
  });

  it('requires OS-keyed immutable receipts for production-real Win11 and legacy-compatible Win10', () => {
    const win11 = receipt('windows-11-24h2-production-real');
    const win10Runner = {
      ...healthy,
      labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win10-22h2'],
      os: { family: 'win10' as const, version: '10.0.19045' },
      environment: { snapshotId: 'env-win10', sha256: 'f'.repeat(64) },
    };
    const win10 = receipt('windows-10-22h2-legacy-compatibility', {
      runner: win10Runner,
      environment: win10Runner.environment,
    });
    expect(aggregateGateEReceipts([win11, win10])).toMatchObject({
      status: 'passed',
      receiptIds: [win11.receiptId, win10.receiptId],
    });
    expect(aggregateGateEReceipts([win11])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_REQUIRED_RECEIPT_MISSING',
      missing: ['windows-10-22h2-legacy-compatibility'],
    });
    expect(aggregateGateEReceipts([win10])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_REQUIRED_RECEIPT_MISSING',
      missing: ['windows-11-24h2-production-real'],
    });
  });
});
