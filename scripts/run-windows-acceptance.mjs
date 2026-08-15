// scripts/run-windows-acceptance.mjs — Gate E OS-keyed 真实验收 runner（W6-02 三件套哈希链）
// --produce-receipt --os-key win11-24h2|win10-22h2 --run <uuid> [--runner-snapshot <path>] [--scenario-dir <dir>]
//   产出 receipt-core.json → manifest.json（hash core+附件）→ receipt-index.json（引用两者 hash）；
//   物理前置缺失 → 诚实 blocked receipt + exit 2
// --aggregate-receipts --run <uuid> --receipt <dir> --receipt <dir>：两个 OS-keyed receipt 目录聚合
//   （先重算 index/manifest/rootDigest/entries，再解析 core），原子写 latest-run.json
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

const { evaluateWindowsRunner, aggregateGateEReceipts, computeRootDigest } = await import('../src/release/windowsAcceptanceContract.mjs');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);

const receiptsRoot = resolve('artifacts/release-evidence');

const EMPTY_RUNNER = {
  selfHosted: false, labels: [], interactive: false, unlocked: false, inputDesktop: '', sessionId: 0,
  os: { family: 'unknown', version: '0' }, node: { version: '0', arch: 'x64' },
  microphones: [], sapiVoices: [], sapiPlaybackPassed: false,
  fixtures: { lockSha256: '', sourceHashesValid: false, artifactHashesValid: false }, monitors: [],
};

function loadRunnerSnapshot(explicitPath) {
  if (explicitPath) {
    // W6-02：显式 --runner-snapshot 必须存在且可解析（缺失/坏 JSON → 诚实 blocked，绝不静默退化）
    const file = resolve(explicitPath);
    if (!existsSync(file)) {
      console.error(`WINDOWS_RUNNER_SNAPSHOT_MISSING: ${explicitPath}`);
      process.exit(2);
    }
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (cause) {
      console.error(`WINDOWS_RUNNER_SNAPSHOT_INVALID: ${String(cause?.message ?? cause)}`);
      process.exit(2);
    }
  }
  const defaultPath = resolve('scripts/provisioned-runner.json');
  return existsSync(defaultPath) ? JSON.parse(readFileSync(defaultPath, 'utf8')) : EMPTY_RUNNER;
}

/** 三件套写盘：core → manifest（core+附件哈希）→ index（引用两者哈希）——closure 不落 core */
function writeReceiptBundle(runId, receiptKey, core) {
  const dir = join(receiptsRoot, runId, `receipt-${receiptKey}`);
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  const coreBytes = Buffer.from(`${JSON.stringify(core, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'receipt-core.json'), coreBytes, 'utf8');
  const entries = [{ path: 'receipt-core.json', bytes: coreBytes.length, sha256: sha256(coreBytes) }];
  for (const scenario of core.scenarios) {
    for (const attachmentId of scenario.attachmentIds) {
      const file = join(dir, attachmentId);
      if (!existsSync(file)) {
        console.error(`WINDOWS_RECEIPT_ATTACHMENT_MISSING: ${attachmentId}`);
        process.exit(2);
      }
      const bytes = readFileSync(file);
      entries.push({ path: attachmentId, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  const manifest = { algorithm: 'sha256', rootDigest: computeRootDigest(entries), entries };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'manifest.json'), manifestBytes, 'utf8');
  const index = {
    receiptKey, receiptId: core.receiptId, runId,
    coreSha256: sha256(coreBytes), manifestSha256: sha256(manifestBytes),
  };
  writeFileSync(join(dir, 'receipt-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return dir;
}

/** 场景结果目录：<dir>/*.json（{id,status,attachmentIds}）+ 相对附件文件 → 拷贝进 receipt 附件区 */
function loadScenarioResults(scenarioDir, receiptDir, decisionStatus) {
  if (!scenarioDir || !existsSync(scenarioDir)) {
    return [{ id: 'preflight', status: decisionStatus === 'passed' ? 'passed' : 'blocked', attachmentIds: [] }];
  }
  const scenarios = [];
  for (const name of readdirSync(scenarioDir).filter(n => n.endsWith('.json')).sort()) {
    const result = JSON.parse(readFileSync(join(scenarioDir, name), 'utf8'));
    const attachmentIds = [];
    for (const attachmentId of result.attachmentIds ?? []) {
      const source = join(scenarioDir, attachmentId);
      if (!existsSync(source)) {
        console.error(`WINDOWS_RECEIPT_ATTACHMENT_MISSING: ${attachmentId}`);
        process.exit(2);
      }
      const target = join(receiptDir, attachmentId);
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(source, target);
      attachmentIds.push(attachmentId);
    }
    scenarios.push({ id: result.id ?? basename(name, '.json'), status: result.status ?? 'blocked', attachmentIds });
  }
  return scenarios;
}

if (has('--produce-receipt')) {
  const osKey = flag('--os-key');
  const runId = flag('--run');
  if (!runId || !['win11-24h2', 'win10-22h2'].includes(osKey)) {
    console.error('usage: --produce-receipt --os-key win11-24h2|win10-22h2 --run <uuid> [--runner-snapshot <path>] [--scenario-dir <dir>]');
    process.exit(2);
  }
  const runner = loadRunnerSnapshot(flag('--runner-snapshot'));
  // W6-07：候选绑定真实计算并在评估前并入快照（此前快照三哈希恒空 →
  // WINDOWS_RUNNER_NOT_SELF_HOSTED 恒命中；供给脚本只做机器探测，绑定在 receipt 生产时完成）
  const runDir = join(receiptsRoot, runId);
  let candidate = {};
  try { candidate = existsSync(join(runDir, 'candidate.json')) ? JSON.parse(readFileSync(join(runDir, 'candidate.json'), 'utf8')) : {}; } catch { candidate = {}; }
  const envSnapshotJson = JSON.stringify(runner);
  const envSnapshotHash = sha256(envSnapshotJson);
  const capabilityHash = (() => {
    const dir = resolve('tests/acceptance/windows');
    try {
      const parts = readdirSync(dir).filter(name => name.endsWith('.ps1')).sort().map(name => `${name}:${sha256(readFileSync(join(dir, name)))}`);
      return sha256(parts.join('\n'));
    } catch { return ''; }
  })();
  const boundArtifact = { id: candidate.artifactId ?? candidate.candidateId ?? '', sha256: candidate.tgzSha256 ?? '' };
  const boundEnvironment = { snapshotId: envSnapshotHash.slice(0, 16), sha256: envSnapshotHash };
  const boundCapability = { snapshotId: 'windows-acceptance-scenarios-v1', sha256: capabilityHash };
  // W6-08：tier=single-display（用户决策）——数学层证据必须真实在场并哈希绑定
  const tier = flag('--tier') === 'single-display' ? 'single-display' : 'full';
  let waiverEvidence = null;
  if (tier === 'single-display') {
    const mathFile = join(receiptsRoot, runId, 'multimonitor-math', 'outcome.json');
    if (!existsSync(mathFile)) {
      console.error('SINGLE_DISPLAY_TIER_REQUIRES_MATH_EVIDENCE: multimonitor-math outcome.json missing');
      process.exit(2);
    }
    waiverEvidence = { path: 'multimonitor-math/outcome.json', sha256: sha256(readFileSync(mathFile)) };
  }
  const boundRunner = {
    ...runner,
    artifact: boundArtifact,
    environment: boundEnvironment,
    capability: boundCapability,
    candidateCommit: runner.candidateCommit ?? candidate.commit ?? '',
  };
  const decision = evaluateWindowsRunner(boundRunner, { tier });
  const receiptKey = osKey === 'win11-24h2' ? 'windows-11-24h2-production-real' : 'windows-10-22h2-legacy-compatibility';
  const receiptId = `receipt-${receiptKey}`;
  const receiptDir = join(receiptsRoot, runId, `receipt-${receiptKey}`);
  mkdirSync(receiptDir, { recursive: true });
  const scenarios = loadScenarioResults(flag('--scenario-dir'), receiptDir, decision.status);
  // 诚实 blocked：物理前置缺失时场景一律 blocked（绝不伪造 passed）
  const effectiveScenarios = decision.status === 'passed'
    ? scenarios
    : scenarios.map(scenario => ({ ...scenario, status: 'blocked', attachmentIds: [] }));
  const core = {
    receiptId, receiptKey, runId,
    ...(tier === 'single-display' ? { tier: 'single-display', waived: decision.waived ?? [], waiverEvidence } : {}),
    candidateCommit: boundRunner.candidateCommit,
    artifact: boundArtifact,
    environment: boundEnvironment,
    capability: boundCapability,
    runner: boundRunner,
    fixtures: runner.fixtures ?? { lockSha256: '', sourceHashesValid: false, artifactHashesValid: false },
    scenarios: effectiveScenarios,
  };
  writeReceiptBundle(runId, receiptKey, core);
  if (decision.status !== 'passed') {
    console.error(`WINDOWS_PHYSICAL_PRECONDITION_BLOCKED: ${decision.missing?.join(', ')}`);
    process.exit(2);
  }
  console.log(JSON.stringify({ receiptId, receiptKey, status: 'produced' }));
  process.exit(0);
}

if (has('--aggregate-receipts')) {
  const runId = flag('--run');
  const receiptDirs = args.reduce((acc, value, index) => (value === '--receipt' ? [...acc, args[index + 1]] : acc), []);
  const scope = flag('--scope');
  // W6-08：win11-only 档只需 1 个 receipt（win10 遗赠 receipt 声明性豁免）；full 档仍要求 2 个
  const requiredCount = scope === 'win11-only' ? 1 : 2;
  if (!runId || receiptDirs.length !== requiredCount) {
    console.error('usage: --aggregate-receipts --run <uuid> --receipt <dir> [--receipt <dir>] [--scope win11-only]');
    process.exit(2);
  }
  const waiverEvidenceFile = flag('--waiver-evidence') ? resolve(flag('--waiver-evidence')) : undefined;
  const decision = aggregateGateEReceipts(receiptDirs.map(dir => resolve(dir)), { waiverEvidenceFile, scope });
  const dir = join(receiptsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate-e-aggregate.json'), JSON.stringify(decision, null, 2), 'utf8');
  writeFileSync(join(receiptsRoot, 'latest-run.json'), JSON.stringify({ runId, wave: 3, manifestPath: join(dir, 'gate-e-aggregate.json') }, null, 2), 'utf8');
  console.log(JSON.stringify(decision));
  process.exit(decision.status === 'passed' ? 0 : 2);
}

console.error('usage: --produce-receipt | --aggregate-receipts');
process.exit(2);
