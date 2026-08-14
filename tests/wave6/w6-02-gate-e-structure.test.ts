// tests/wave6/w6-02-gate-e-structure.test.ts — W6-02 契约：Gate E receipt 三件套哈希链 + aggregator 先重算（RED → 实现后全绿）
// receipt-core.json（无 manifest hash/closure）→ manifest.json（hash core+附件，rootDigest 重算）→
// manifest 外 receipt-index.json（引用两者 hash）；closure 由 validator 从 required 场景计算；
// aggregator 先重算 index→manifest→rootDigest→entries，再解析 core；任一环篡改/缺失 → blocked。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateGateEReceipts, evaluateWindowsRunner, REQUIRED_WINDOWS_SCENARIOS } from '../../src/release/windowsAcceptanceContract.mjs';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const COMMIT = 'a'.repeat(40);
const ARTIFACT_SHA = 'b'.repeat(64);

/** 满足全部物理前置的合成 runner 快照（evaluateWindowsRunner → passed） */
const healthyRunner = (family: 'win10' | 'win11') => ({
  selfHosted: true,
  labels: ['self-hosted', 'windows', 'x64', 'interactive', family === 'win11' ? 'win11-24h2' : 'win10-22h2'],
  interactive: true, unlocked: true, inputDesktop: 'Default', sessionId: 1,
  os: { family, version: family === 'win11' ? '10.0.26100.1000' : '10.0.19045.1000' },
  node: { version: '22.11.0', arch: 'x64' as const },
  candidateCommit: COMMIT,
  artifact: { id: 'wxnodus-art', sha256: ARTIFACT_SHA },
  environment: { snapshotId: 'env-1', sha256: 'e'.repeat(64) },
  capability: { snapshotId: 'cap-1', sha256: 'f'.repeat(64) },
  microphones: [{ id: 'mic-1', active: true, physical: true }],
  sapiVoices: ['Microsoft Huihui Desktop'], sapiPlaybackPassed: true,
  fixtures: { lockSha256: '9'.repeat(64), sourceHashesValid: true, artifactHashesValid: true },
  monitors: [
    { id: 'm1', x: -1920, y: 0, width: 1920, height: 1080, scale: 1.0, physical: true },
    { id: 'm2', x: 0, y: 0, width: 2560, height: 1440, scale: 1.5, physical: true },
  ],
});

/** manifest rootDigest：排序 path\0bytes\0sha256 行哈希（fileEvidenceStore 同款约定） */
const rootDigest = (entries: Array<{ path: string; bytes: number; sha256: string }>): string =>
  sha256([...entries].sort((a, b) => a.path.localeCompare(b.path)).map(e => `${e.path}\0${e.bytes}\0${e.sha256}`).join('\n'));

interface ReceiptBuild {
  dir: string;
  receiptKey: string;
  core: Record<string, unknown>;
  coreSha256: string;
  manifestSha256: string;
}

function buildReceipt(family: 'win10' | 'win11', scenarios: Array<{ id: string; status: string; attachmentIds: string[] }>, attachmentFiles: Record<string, string>): ReceiptBuild {
  const dir = mkdtempSync(join(tmpdir(), 'w6-e-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const receiptKey = family === 'win11' ? 'windows-11-24h2-production-real' : 'windows-10-22h2-legacy-compatibility';
  const core = {
    receiptId: `receipt-${family}`, receiptKey, runId: 'run-w6-02', candidateCommit: COMMIT,
    artifact: { id: 'wxnodus-art', sha256: ARTIFACT_SHA },
    environment: { snapshotId: 'env-1', sha256: 'e'.repeat(64) },
    capability: { snapshotId: 'cap-1', sha256: 'f'.repeat(64) },
    runner: healthyRunner(family),
    fixtures: { lockSha256: '9'.repeat(64), sourceHashesValid: true, artifactHashesValid: true },
    scenarios,
  };
  const coreBytes = Buffer.from(`${JSON.stringify(core, null, 2)}\n`, 'utf8');
  const entries = [{ path: 'receipt-core.json', bytes: coreBytes.length, sha256: sha256(coreBytes) }];
  for (const [name, content] of Object.entries(attachmentFiles)) {
    const bytes = Buffer.from(content, 'utf8');
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', name), bytes);
    entries.push({ path: `attachments/${name}`, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { algorithm: 'sha256', rootDigest: rootDigest(entries), entries };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const coreSha256 = sha256(coreBytes);
  const manifestSha256 = sha256(manifestBytes);
  writeFileSync(join(dir, 'receipt-core.json'), coreBytes);
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  writeFileSync(join(dir, 'receipt-index.json'), `${JSON.stringify({ receiptKey, receiptId: `receipt-${family}`, runId: 'run-w6-02', coreSha256, manifestSha256 }, null, 2)}\n`, 'utf8');
  return { dir, receiptKey, core, coreSha256, manifestSha256 };
}

const allScenarios = (): Array<{ id: string; status: string; attachmentIds: string[] }> =>
  ['preflight', 'voice', 'computer-multimonitor', 'browser', 'build-restart-readback', 'uia', 'emergency-stop']
    .map(id => ({ id, status: 'passed', attachmentIds: [`att-${id}`] }));

const allAttachments = (): Record<string, string> => Object.fromEntries(
  ['preflight', 'voice', 'computer-multimonitor', 'browser', 'build-restart-readback', 'uia', 'emergency-stop']
    .map(id => [`${id}.json`, JSON.stringify({ id, ok: true })]),
);

describe('W6-02 Gate E receipt 三件套哈希链', () => {
  it('REQUIRED_WINDOWS_SCENARIOS 覆盖七个必需场景', () => {
    expect([...REQUIRED_WINDOWS_SCENARIOS].sort()).toEqual(
      ['browser', 'build-restart-readback', 'computer-multimonitor', 'emergency-stop', 'preflight', 'uia', 'voice'],
    );
  });

  it('双 OS receipt 完整哈希链 → aggregator 重算通过 → passed', () => {
    const win11 = buildReceipt('win11', allScenarios(), allAttachments());
    const win10 = buildReceipt('win10', allScenarios(), allAttachments());
    const result = aggregateGateEReceipts([win11.dir, win10.dir] as never);
    expect(result).toMatchObject({ status: 'passed', receiptIds: ['receipt-win11', 'receipt-win10'] });
  });

  it('篡改 receipt-core（index 哈希漂移）→ WINDOWS_RECEIPT_CORE_MISMATCH', () => {
    const win11 = buildReceipt('win11', allScenarios(), allAttachments());
    buildReceipt('win10', allScenarios(), allAttachments());
    const tampered = { ...JSON.parse(readFileSync(join(win11.dir, 'receipt-core.json'), 'utf8')), candidateCommit: 'f'.repeat(40) };
    writeFileSync(join(win11.dir, 'receipt-core.json'), JSON.stringify(tampered, null, 2));
    // 附件哈希无关——核心文件漂移即拒
    const result = aggregateGateEReceipts([win11.dir, mkdtempSync(join(tmpdir(), 'w6-e-other-'))] as never);
    expect(result).toMatchObject({ status: 'blocked', code: 'WINDOWS_RECEIPT_CORE_MISMATCH' });
  });

  it('附件内容篡改（manifest 条目哈希漂移）→ WINDOWS_RECEIPT_ATTACHMENT_MISMATCH', () => {
    const win11 = buildReceipt('win11', allScenarios(), allAttachments());
    writeFileSync(join(win11.dir, 'attachments', 'voice.json'), JSON.stringify({ id: 'voice', ok: false }), 'utf8');
    const result = aggregateGateEReceipts([win11.dir, mkdtempSync(join(tmpdir(), 'w6-e-other2-'))] as never);
    expect(result).toMatchObject({ status: 'blocked', code: 'WINDOWS_RECEIPT_ATTACHMENT_MISMATCH' });
  });

  it('必需场景缺失 → WINDOWS_RECEIPT_SCENARIO_MISSING；场景失败 → WINDOWS_ACCEPTANCE_SCENARIO_FAILED', () => {
    const missingVoice = buildReceipt('win11', allScenarios().filter(s => s.id !== 'voice'), allAttachments());
    expect(aggregateGateEReceipts([missingVoice.dir, mkdtempSync(join(tmpdir(), 'w6-e-x-'))] as never))
      .toMatchObject({ status: 'blocked', code: 'WINDOWS_RECEIPT_SCENARIO_MISSING' });
    const failedBrowser = buildReceipt('win11', allScenarios().map(s => (s.id === 'browser' ? { ...s, status: 'failed' } : s)), allAttachments());
    expect(aggregateGateEReceipts([failedBrowser.dir, mkdtempSync(join(tmpdir(), 'w6-e-y-'))] as never))
      .toMatchObject({ status: 'blocked', code: 'WINDOWS_ACCEPTANCE_SCENARIO_FAILED' });
  });

  it('双 receipt 候选不一致（runId/commit/artifact）→ WINDOWS_RECEIPT_CANDIDATE_MISMATCH', () => {
    const win11 = buildReceipt('win11', allScenarios(), allAttachments());
    const win10 = buildReceipt('win10', allScenarios(), allAttachments());
    const core = JSON.parse(readFileSync(join(win10.dir, 'receipt-core.json'), 'utf8')) as Record<string, unknown>;
    core.artifact = { id: 'other-art', sha256: 'c'.repeat(64) };
    writeFileSync(join(win10.dir, 'receipt-core.json'), JSON.stringify(core, null, 2));
    const result = aggregateGateEReceipts([win11.dir, win10.dir] as never);
    expect(result).toMatchObject({ status: 'blocked', code: 'WINDOWS_RECEIPT_CANDIDATE_MISMATCH' });
  });

  it('物理前置仍强制：缺麦克风 → WINDOWS_PHYSICAL_PRECONDITION_BLOCKED', () => {
    const runner = { ...healthyRunner('win11'), microphones: [] };
    expect(evaluateWindowsRunner(runner)).toMatchObject({
      status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED',
      missing: expect.arrayContaining(['WINDOWS_MICROPHONE_REQUIRED']),
    });
  });
});
