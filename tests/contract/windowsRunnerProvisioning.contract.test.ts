// tests/contract/windowsRunnerProvisioning.contract.test.ts — W3-10 Step 1 → W6-02：受控 Windows runner 契约
// evaluateWindowsRunner 物理前置（不变）；aggregateGateEReceipts 迁至 receipt 目录三件套（receipt-core/manifest/index）
// ——aggregator 先重算哈希链再解析 core。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateGateEReceipts, computeRootDigest, evaluateWindowsRunner } from '../../src/release/windowsAcceptanceContract.mjs';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const healthy = {
  selfHosted: true,
  labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win11-24h2'],
  interactive: true,
  unlocked: true,
  inputDesktop: 'Default',
  sessionId: 2,
  os: { family: 'win11' as const, version: '10.0.26100' },
  node: { version: '22.14.0', arch: 'x64' as const },
  candidateCommit: 'c'.repeat(40),
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

const REQUIRED = ['preflight', 'voice', 'computer-multimonitor', 'browser', 'build-restart-readback', 'uia', 'emergency-stop'];

/** receipt 目录三件套构造：core（无 closure/manifest hash）→ manifest（hash core+附件）→ index（引用两者） */
function writeReceiptDir(
  receiptKey: 'windows-11-24h2-production-real' | 'windows-10-22h2-legacy-compatibility',
  runner: Parameters<typeof evaluateWindowsRunner>[0],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'w3-e-receipt-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const scenarios = REQUIRED.map(id => ({ id, status: 'passed' as const, attachmentIds: [`attachments/${id}.json`] }));
  const core = {
    receiptId: `receipt-${receiptKey}`, receiptKey, runId: 'run-w3-e',
    candidateCommit: runner.candidateCommit, artifact: runner.artifact,
    environment: runner.environment, capability: runner.capability,
    runner, fixtures: runner.fixtures, scenarios,
  };
  const coreBytes = Buffer.from(`${JSON.stringify(core, null, 2)}\n`, 'utf8');
  const entries = [{ path: 'receipt-core.json', bytes: coreBytes.length, sha256: sha256(coreBytes) }];
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  for (const id of REQUIRED) {
    const bytes = Buffer.from(JSON.stringify({ id, ok: true }), 'utf8');
    writeFileSync(join(dir, 'attachments', `${id}.json`), bytes);
    entries.push({ path: `attachments/${id}.json`, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { algorithm: 'sha256', rootDigest: computeRootDigest(entries), entries };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'receipt-core.json'), coreBytes);
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  writeFileSync(join(dir, 'receipt-index.json'), `${JSON.stringify({
    receiptKey, receiptId: core.receiptId, runId: 'run-w3-e',
    coreSha256: sha256(coreBytes), manifestSha256: sha256(manifestBytes),
  }, null, 2)}\n`, 'utf8');
  return dir;
}

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
    const win11Dir = writeReceiptDir('windows-11-24h2-production-real', healthy);
    const win10Runner = {
      ...healthy,
      labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win10-22h2'],
      os: { family: 'win10' as const, version: '10.0.19045' },
      environment: { snapshotId: 'env-win10', sha256: 'f'.repeat(64) },
    };
    const win10Dir = writeReceiptDir('windows-10-22h2-legacy-compatibility', win10Runner);
    expect(aggregateGateEReceipts([win11Dir, win10Dir])).toMatchObject({
      status: 'passed',
      receiptIds: ['receipt-windows-11-24h2-production-real', 'receipt-windows-10-22h2-legacy-compatibility'],
    });
    expect(aggregateGateEReceipts([win11Dir])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_REQUIRED_RECEIPT_MISSING',
    });
    expect(aggregateGateEReceipts([win10Dir])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_REQUIRED_RECEIPT_MISSING',
    });
  });

  it('recompute-first：篡改 core 文件（index 哈希漂移）→ WINDOWS_RECEIPT_CORE_MISMATCH', () => {
    const win11Dir = writeReceiptDir('windows-11-24h2-production-real', healthy);
    const win10Dir = writeReceiptDir('windows-10-22h2-legacy-compatibility', {
      ...healthy,
      labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win10-22h2'],
      os: { family: 'win10', version: '10.0.19045' },
    });
    const core = JSON.parse(readFileSync(join(win11Dir, 'receipt-core.json'), 'utf8')) as Record<string, unknown>;
    core.runId = 'tampered';
    writeFileSync(join(win11Dir, 'receipt-core.json'), JSON.stringify(core, null, 2));
    expect(aggregateGateEReceipts([win11Dir, win10Dir])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_RECEIPT_CORE_MISMATCH',
    });
  });
});
