// scripts/run-wave3-gates.mjs — Wave 3 scoped Gate runner：
// 1. 建 artifacts/release-evidence/<runId> 并在执行任何 gate 之前原子写 latest-run.json
// 2. 只执行 A-W3/B-W3/C-W3/D-W3/E-W3/F-W3；C-W3 绑定当前候选；E-W3 要求两个 OS-keyed receipt；G-W3 走 completion gate
// 3. 退出码：0 succeeded / 1 failed / 2 blocked / 3 incomplete / 4 inconclusive / 130 cancelled
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseGateBindings } from '../src/release/gateBindings.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const rootDir = resolve(process.env.WXNODUS_ROOT ?? process.cwd());
const args = process.argv.slice(2);
const runFlag = args.indexOf('--run');
const runId = runFlag >= 0 ? args[runFlag + 1] : `wave3-${Date.now().toString(36)}`;

const runDir = join(rootDir, 'artifacts', 'release-evidence', runId);
mkdirSync(runDir, { recursive: true });
const latestPath = join(rootDir, 'artifacts', 'release-evidence', 'latest-run.json');
writeFileSync(latestPath, JSON.stringify({ runId, wave: 3, manifestPath: join(runDir, 'manifest.json') }, null, 2), 'utf8');

const exitFor = { succeeded: 0, failed: 1, blocked: 2, incomplete: 3, inconclusive: 4, cancelled: 130 };

function run(command, extraArgs = []) {
  const result = spawnSync(command, extraArgs, { cwd: rootDir, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status ?? 1;
}

// 前置：候选绑定（--candidate-commit/--artifact-id/--artifact-sha256/--environment-snapshot）
// W8-19：parseGateBindings 统一转 camelCase（此前 kebab 存/camel 读——绑定恒空，C-W3 假 blocked）
const binding = parseGateBindings(args);
const drillArgs = [
  '--run', runId,
  '--candidate-commit', binding.candidateCommit ?? process.env.WXNODUS_W3_CANDIDATE_COMMIT ?? '',
  '--artifact-id', binding.artifactId ?? 'artifact-w3-candidate',
  '--artifact-sha256', binding.artifactSha256 ?? '',
  '--environment-snapshot', binding.environmentSnapshot ?? 'environment-w3',
];

const gateResults = {};
let firstFailure = null;

const runGate = (id, command, extra = []) => {
  const status = run(command, extra);
  gateResults[id] = { status };
  if (status !== 0 && firstFailure === null) firstFailure = id;
  return status;
};

// A-W3：本 Wave 编译/类型
runGate('A-W3', 'npm.cmd', ['run', 'build']);
// B-W3：精确 test manifest
runGate('B-W3', 'npm.cmd', ['exec', '--', 'vitest', 'run',
  'tests/unit/quality/verifierRegistry.contract.test.ts',
  'tests/integration/evidenceAuthorityConflict.test.ts',
  'tests/integration/failurePropagation.test.ts',
  'tests/unit/tui/reducer-projector.contract.test.ts',
  'tests/contract/gatewayClient.contract.test.ts',
  'tests/integration/frontendParity.test.ts',
  'tests/unit/voice/audioDeviceService.test.ts',
  'tests/unit/voice/voice-domain.contract.test.ts',
  'tests/unit/voice/wavWriter.test.ts',
  'tests/integration/voiceSession.test.ts',
  'tests/integration/voiceHeadlessParity.test.ts',
  'tests/failure/voiceWorkerFailure.test.ts',
  'tests/unit/computer/highImpactApproval.test.ts',
  'tests/unit/computer/postcondition.test.ts',
  'tests/unit/computer/driverContracts.test.ts',
  'tests/integration/computerUsePipeline.test.ts',
  'tests/integration/computerFrontendParity.test.ts',
  'tests/integration/emergencyStop.test.ts',
  'tests/integration/browserIsolation.test.ts',
  'tests/failure/driverFallback.test.ts',
  'tests/unit/build/buildContracts.test.ts',
  'tests/integration/buildService.test.ts',
  'tests/integration/buildRestartReadback.test.ts',
  'tests/integration/buildEvidenceDecision.test.ts',
  'tests/failure/buildVerifierFailure.test.ts',
  'tests/contract/pty.contract.test.ts',
  'tests/failure/ptyLifecycle.test.ts',
  'tests/contract/windowsRunnerProvisioning.contract.test.ts',
  'tests/integration/wave3-current-migration-recovery.test.ts',
  'tests/integration/wave3-headless-e2e.test.ts',
  'tests/integration/wave3-legacy-bypass.test.ts',
  'tests/integration/wave3-gate-scope.test.ts',
]);
// C-W3：当前候选 recovery drill。drill 从 repo 根读 candidate-artifact.bin——装配时由冻结 tgz 供给：
// 哈希与绑定一致才放置（不一致绝不放置，drill 如实 blocked）；跑完即清，绝不残留。
const artifactBin = join(rootDir, 'candidate-artifact.bin');
const frozenTgz = join(runDir, 'wxnodus-3.0.0.tgz');
let placedArtifactBin = false;
if (binding.artifactSha256 && existsSync(frozenTgz) && sha256(readFileSync(frozenTgz)) === binding.artifactSha256) {
  copyFileSync(frozenTgz, artifactBin);
  placedArtifactBin = true;
}
runGate('C-W3', 'node', ['scripts/drill-wave3-recovery.mjs', ...drillArgs]);
if (placedArtifactBin) rmSync(artifactBin, { force: true });
// D-W3：headless e2e
runGate('D-W3', 'npm.cmd', ['exec', '--', 'vitest', 'run', 'tests/integration/wave3-headless-e2e.test.ts']);
// E-W3：双 OS-keyed 真实验收 receipt 聚合（缺失 → blocked）
const eReceipts = args.reduce((acc, value, index) => (value === '--receipt' ? [...acc, args[index + 1]] : acc), []);
if (eReceipts.length === 2) {
  runGate('E-W3', 'node', ['scripts/run-windows-acceptance.mjs', '--aggregate-receipts', '--run', runId, '--receipt', eReceipts[0], '--receipt', eReceipts[1]]);
} else {
  gateResults['E-W3'] = { status: 2, blocked: 'WINDOWS_REQUIRED_RECEIPT_MISSING' };
  firstFailure ??= 'E-W3';
}
// F-W3：安全面
runGate('F-W3', 'npm.cmd', ['exec', '--', 'vitest', 'run', 'tests/integration/wave3-legacy-bypass.test.ts']);
// G-W3：completion gate（只消费闭合证据）
runGate('G-W3', 'npm.cmd', ['run', 'gate:completion', '--', '--run', runId]);

// W8-16（实盘缺陷）：gates 必须为数字状态码 map（0 passed/1 failed/2 blocked/…）——
// evidenceIndexImporter/finalize legacy-reachability/buildGateOutcomes 的契约 schema 均为数字；
// 此前写 {status} 对象导致 importer 全跳过（entries=0）且 F-W3 永不为 0。每门细节保留在 details。
const gateStatuses = Object.fromEntries(Object.entries(gateResults).map(([id, r]) => [id, r.status]));
const report = { runId, wave: 3, gates: gateStatuses, details: gateResults, firstFailure };
const reportPath = join(runDir, 'gate-report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(report)}\n`);

if (firstFailure === 'E-W3' && eReceipts.length !== 2) process.exitCode = 2;
else if (firstFailure === 'C-W3' && !existsSync(join(rootDir, 'migrations', 'c-w3-receipt.json'))) process.exitCode = 2;
// G-W3：completion 子进程的终态码原样传播（blocked 2 / incomplete 3 / inconclusive 4 / cancelled 130 不被压成 failed 1）
else if (firstFailure === 'G-W3') process.exitCode = gateResults['G-W3'].status ?? 2;
else if (firstFailure) process.exitCode = exitFor.failed;
else process.exitCode = exitFor.succeeded;
