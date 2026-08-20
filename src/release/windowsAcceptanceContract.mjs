// src/release/windowsAcceptanceContract.mjs — W6-02 受控 Windows runner 与 Gate E 双 OS-keyed 不可变 receipt：
// receipt-core.json（无 manifest hash/closure）→ manifest.json（hash core+附件，rootDigest 重算）→
// manifest 外 receipt-index.json（引用两者 hash）。aggregator 先重算 index→manifest→rootDigest→entries，
// 再解析 core；closure 由 validator 从 required 场景计算（全 passed + 附件哈希锁定）。任一环篡改/缺失 → blocked。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SHA256_RE = /^[a-f0-9]{64}$/;

export const REQUIRED_WINDOWS_SCENARIOS = [
  'preflight', 'voice', 'computer-multimonitor', 'browser', 'build-restart-readback', 'uia', 'emergency-stop',
];

/** manifest rootDigest：排序 path\0bytes\0sha256 行哈希（fileEvidenceStore 同款约定） */
export const computeRootDigest = (entries) =>
  sha256([...entries].sort((a, b) => a.path.localeCompare(b.path)).map(e => `${e.path}\0${e.bytes}\0${e.sha256}`).join('\n'));

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

/** 单 receipt 目录重算优先校验：index→manifest→rootDigest→entries（core+附件逐文件哈希）；通过则返回 { core, index } */
function verifyReceiptDir(dir) {
  const index = readJson(join(dir, 'receipt-index.json'));
  if (!index || typeof index.coreSha256 !== 'string' || !SHA256_RE.test(index.coreSha256) ||
      typeof index.manifestSha256 !== 'string' || !SHA256_RE.test(index.manifestSha256)) {
    return { blocked: 'WINDOWS_RECEIPT_INDEX_INVALID' };
  }
  const coreFile = join(dir, 'receipt-core.json');
  if (!existsSync(coreFile)) return { blocked: 'WINDOWS_RECEIPT_CORE_MISSING' };
  const coreBytes = readFileSync(coreFile);
  if (sha256(coreBytes) !== index.coreSha256) return { blocked: 'WINDOWS_RECEIPT_CORE_MISMATCH' };
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) return { blocked: 'WINDOWS_RECEIPT_MANIFEST_MISSING' };
  const manifestBytes = readFileSync(manifestFile);
  if (sha256(manifestBytes) !== index.manifestSha256) return { blocked: 'WINDOWS_RECEIPT_MANIFEST_MISMATCH' };
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { return { blocked: 'WINDOWS_RECEIPT_MANIFEST_MISMATCH' }; }
  if (manifest?.algorithm !== 'sha256' || !Array.isArray(manifest.entries) || manifest.entries.length === 0 ||
      typeof manifest.rootDigest !== 'string' || !SHA256_RE.test(manifest.rootDigest)) {
    return { blocked: 'WINDOWS_RECEIPT_MANIFEST_INVALID' };
  }
  if (computeRootDigest(manifest.entries) !== manifest.rootDigest) return { blocked: 'WINDOWS_RECEIPT_ROOT_DIGEST_MISMATCH' };
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || entry.path.includes('..') || entry.path.includes('\\') || entry.path.startsWith('/') ||
        typeof entry.bytes !== 'number' || typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
      return { blocked: 'WINDOWS_RECEIPT_MANIFEST_INVALID' };
    }
    const file = join(dir, entry.path);
    if (!existsSync(file)) return { blocked: 'WINDOWS_RECEIPT_ENTRY_MISSING' };
    const bytes = readFileSync(file);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      return { blocked: entry.path === 'receipt-core.json' ? 'WINDOWS_RECEIPT_CORE_MISMATCH' : 'WINDOWS_RECEIPT_ATTACHMENT_MISMATCH' };
    }
  }
  let core;
  try { core = JSON.parse(coreBytes.toString('utf8')); } catch { return { blocked: 'WINDOWS_RECEIPT_CORE_MISMATCH' }; }
  return { core, index, manifest };
}

const receiptKeyMatchesRunner = (receipt) =>
  receipt.receiptKey === 'windows-11-24h2-production-real'
    ? receipt.runner.os.family === 'win11' && receipt.runner.labels.includes('win11-24h2')
    : receipt.runner.os.family === 'win10' && receipt.runner.labels.includes('win10-22h2');

export function aggregateGateEReceipts(receiptDirs, opts = {}) {
  // W6-08（用户决策）：scope=win11-only 时 win10 遗赠 receipt 以声明性 waiver 豁免
  // （需 19045 真机——本机无法生产）；full 档仍要求双 OS receipt
  const scope = opts.scope === 'win11-only' ? 'win11-only' : 'full';
  const required = scope === 'win11-only'
    ? ['windows-11-24h2-production-real']
    : ['windows-11-24h2-production-real', 'windows-10-22h2-legacy-compatibility'];
  if (!Array.isArray(receiptDirs) || receiptDirs.length !== required.length || receiptDirs.some(dir => typeof dir !== 'string')) {
    return { status: 'blocked', code: 'WINDOWS_REQUIRED_RECEIPT_MISSING' };
  }
  // 先重算（绝不先信任何 hash/closure 字段），任一环失败立即 blocked
  const verified = receiptDirs.map(verifyReceiptDir);
  const firstFailure = verified.find(v => v.blocked);
  if (firstFailure) return { status: 'blocked', code: firstFailure.blocked };

  const values = verified.map(v => ({ core: v.core, manifest: v.manifest }));
  const byKey = new Map(values.map(v => [v.core.receiptKey, v]));
  const missing = required.filter(key => !byKey.has(key));
  if (missing.length > 0 || byKey.size !== values.length) {
    return { status: 'blocked', code: 'WINDOWS_REQUIRED_RECEIPT_MISSING', missing };
  }
  const receipts = required.map(key => byKey.get(key).core);

  // closure 由 validator 计算：required 场景完整 + 全 passed + attachmentId 全部落在已哈希锁定的 manifest 条目
  const manifestPaths = new Set(values.flatMap(v => v.manifest.entries.map(e => e.path)));
  const missingScenarios = REQUIRED_WINDOWS_SCENARIOS.filter(id => !receipts.every(r => r.scenarios.some(s => s.id === id)));
  if (missingScenarios.length > 0) return { status: 'blocked', code: 'WINDOWS_RECEIPT_SCENARIO_MISSING', missingScenarios };
  if (receipts.some(r => r.scenarios.some(s => s.status !== 'passed'))) {
    return { status: 'blocked', code: 'WINDOWS_ACCEPTANCE_SCENARIO_FAILED' };
  }
  if (receipts.some(r => r.scenarios.some(s => !Array.isArray(s.attachmentIds) || s.attachmentIds.length === 0 ||
      s.attachmentIds.some(attachmentId => !manifestPaths.has(attachmentId))))) {
    return { status: 'blocked', code: 'WINDOWS_RECEIPT_ATTACHMENT_MISMATCH' };
  }
  const tierOf = receipt => receipt.tier === 'single-display' ? 'single-display' : 'full';
  if (receipts.some(receipt => !receiptKeyMatchesRunner(receipt) || evaluateWindowsRunner(receipt.runner, { tier: tierOf(receipt) }).status !== 'passed')) {
    return { status: 'blocked', code: 'WINDOWS_RECEIPT_KEY_MISMATCH' };
  }
  // W6-08：single-display 档 waiver 必须有数学层证据真实背书（哈希匹配），否则绝不放行
  if (receipts.some(receipt => receipt.tier === 'single-display')) {
    const WAIVED_CANONICAL = ['WINDOWS_MULTIMONITOR_REQUIRED', 'WINDOWS_NEGATIVE_ORIGIN_REQUIRED', 'WINDOWS_MIXED_DPI_REQUIRED'];
    const evFile = opts.waiverEvidenceFile;
    if (!evFile || !existsSync(evFile)) return { status: 'blocked', code: 'WINDOWS_RECEIPT_WAIVER_EVIDENCE_MISSING' };
    const evSha = sha256(readFileSync(evFile));
    const waivedValid = receipts.every(receipt => receipt.tier !== 'single-display' || (
      Array.isArray(receipt.waived) &&
      JSON.stringify([...receipt.waived].sort()) === JSON.stringify([...WAIVED_CANONICAL].sort()) &&
      receipt.waiverEvidence?.sha256 === evSha
    ));
    if (!waivedValid) return { status: 'blocked', code: 'WINDOWS_RECEIPT_WAIVER_EVIDENCE_MISMATCH' };
  }
  const [first, ...rest] = receipts;
  if (rest.some(receipt => receipt.runId !== first.runId || receipt.candidateCommit !== first.candidateCommit ||
      receipt.artifact.id !== first.artifact.id || receipt.artifact.sha256 !== first.artifact.sha256)) {
    return { status: 'blocked', code: 'WINDOWS_RECEIPT_CANDIDATE_MISMATCH' };
  }
  return {
    status: 'passed',
    receiptIds: receipts.map(receipt => receipt.receiptId),
    ...(scope === 'win11-only' ? { scope: 'win11-only', waivedReceiptKeys: ['windows-10-22h2-legacy-compatibility'], waiverReason: 'win10 遗赠兼容 receipt 需 19045 真机（用户决策：Windows-only 单 OS 档）' } : {}),
  };
}

export function evaluateWindowsRunner(snapshot, opts = {}) {
  // W6-08（用户决策）：tier=single-display 时显示器三项 waived（零安装数学层方案背书）；
  // full 档（缺省）形状与行为完全不变（既有 receipt/契约零破坏）
  const tier = opts.tier === 'single-display' ? 'single-display' : 'full';
  const missing = [];
  if (!snapshot.selfHosted || !snapshot.labels.includes('self-hosted') || !snapshot.labels.includes('windows') ||
      !snapshot.labels.includes('x64') || !snapshot.labels.includes('interactive')) missing.push('WINDOWS_RUNNER_NOT_SELF_HOSTED');
  const osLabels = snapshot.labels.filter(label => label === 'win10-22h2' || label === 'win11-24h2');
  if (osLabels.length !== 1) missing.push('WINDOWS_OS_BASELINE_UNSUPPORTED');
  if (!snapshot.interactive || !snapshot.unlocked || snapshot.sessionId <= 0 || snapshot.inputDesktop !== 'Default') missing.push('WINDOWS_INTERACTIVE_SESSION_REQUIRED');
  // W8-14：receipt 必须绑定 40-hex git commit（审计链——receipt 无 commit 即无法定位被验收的候选代码）
  if (!/^[a-f0-9]{40}$/.test(snapshot.candidateCommit ?? '')) missing.push('WINDOWS_RUNNER_CANDIDATE_COMMIT_INVALID');
  // W6-07：node.arch 接受 amd64（Windows PROCESSOR_ARCHITECTURE 真实值——与 x64 同义，不是不同架构）
  if (!snapshot.node.version.startsWith('22.') || (snapshot.node.arch !== 'x64' && snapshot.node.arch !== 'amd64') ||
      !/^[a-f0-9]{64}$/.test(snapshot.artifact.sha256) ||
      !/^[a-f0-9]{64}$/.test(snapshot.environment.sha256) ||
      !/^[a-f0-9]{64}$/.test(snapshot.capability.sha256)) missing.push('WINDOWS_RUNNER_NOT_SELF_HOSTED');
  const build = Number(snapshot.os.version.split('.')[2]);
  // W6-07（用户决策）：win11-24h2 接受 26100 与 26200（同代际构建——本机矩阵扩增，只扩矩阵不降标准）
  const baseline = snapshot.os.family === 'win10'
    ? build === 19045 && osLabels[0] === 'win10-22h2'
    : (build === 26100 || build === 26200) && osLabels[0] === 'win11-24h2';
  if (!baseline) missing.push('WINDOWS_OS_BASELINE_UNSUPPORTED');
  if (!snapshot.microphones.some(device => device.active && device.physical)) missing.push('WINDOWS_MICROPHONE_REQUIRED');
  if (snapshot.sapiVoices.length === 0 || !snapshot.sapiPlaybackPassed) missing.push('WINDOWS_SAPI_REQUIRED');
  if (!snapshot.fixtures.sourceHashesValid || !snapshot.fixtures.artifactHashesValid || !/^[a-f0-9]{64}$/.test(snapshot.fixtures.lockSha256)) missing.push('WINDOWS_FIXTURE_LOCK_INVALID');
  const physicalMonitors = snapshot.monitors.filter(monitor => monitor.physical);
  if (tier === 'full') {
    if (physicalMonitors.length < 2) missing.push('WINDOWS_MULTIMONITOR_REQUIRED');
    if (physicalMonitors.length === 0 || Math.min(...physicalMonitors.map(monitor => monitor.x)) >= 0) missing.push('WINDOWS_NEGATIVE_ORIGIN_REQUIRED');
    if (new Set(physicalMonitors.map(monitor => monitor.scale)).size < 2) missing.push('WINDOWS_MIXED_DPI_REQUIRED');
  }
  // 同一前置可能被多个检查命中（如实报缺失但绝不重复计数）
  const unique = [...new Set(missing)];
  if (tier === 'single-display') {
    const waived = ['WINDOWS_MULTIMONITOR_REQUIRED', 'WINDOWS_NEGATIVE_ORIGIN_REQUIRED', 'WINDOWS_MIXED_DPI_REQUIRED'];
    return unique.length === 0
      ? { status: 'passed', tier: 'single-display', waived }
      : { status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED', missing: unique, tier: 'single-display', waived };
  }
  return unique.length === 0 ? { status: 'passed' } : {
    status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED', missing: unique,
  };
}
