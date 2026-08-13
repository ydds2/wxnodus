// scripts/run-windows-acceptance.mjs — Gate E OS-keyed 真实验收 runner
// --produce-receipt --os-key win11-24h2|win10-22h2 --run <uuid>：单单元 receipt 生产（物理前置缺失 → blocked receipt + exit 2）
// --aggregate-receipts --run <uuid> --receipt <path> --receipt <path>：恰好两个 OS-keyed receipt 聚合，原子写 latest-run.json
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { evaluateWindowsRunner, aggregateGateEReceipts } = await import('../src/release/windowsAcceptanceContract.mjs');

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);

const receiptsRoot = resolve('artifacts/release-evidence');

function writeReceipt(runId, receiptKey, receipt) {
  const dir = join(receiptsRoot, runId, `receipt-${receiptKey}`);
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(receipt, null, 2);
  writeFileSync(join(dir, 'receipt.json'), json, 'utf8');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    algorithm: 'sha256',
    rootDigest: '',
    entries: [{ path: 'receipt.json', bytes: Buffer.byteLength(json), sha256: '' }],
  }, null, 2), 'utf8');
  return dir;
}

if (has('--produce-receipt')) {
  const osKey = flag('--os-key');
  const runId = flag('--run');
  if (!runId || !['win11-24h2', 'win10-22h2'].includes(osKey)) {
    console.error('usage: --produce-receipt --os-key win11-24h2|win10-22h2 --run <uuid>');
    process.exit(2);
  }
  // runner 快照：provision-windows-runner.ps1 的输出（缺失即物理前置 blocked）
  const provisioned = existsSync('scripts/provisioned-runner.json')
    ? JSON.parse(readFileSync('scripts/provisioned-runner.json', 'utf8'))
    : null;
  const runner = provisioned ?? { selfHosted: false, labels: [], interactive: false, unlocked: false, inputDesktop: '', sessionId: 0, os: { family: 'unknown', version: '0' }, node: { version: '0', arch: 'x64' }, microphones: [], sapiVoices: [], sapiPlaybackPassed: false, fixtures: { lockSha256: '', sourceHashesValid: false, artifactHashesValid: false }, monitors: [] };
  const decision = evaluateWindowsRunner(runner);
  const receiptKey = osKey === 'win11-24h2' ? 'windows-11-24h2-production-real' : 'windows-10-22h2-legacy-compatibility';
  const receipt = {
    receiptId: `receipt-${receiptKey}`,
    receiptKey,
    runId,
    candidateCommit: runner.candidateCommit ?? '',
    artifact: runner.artifact ?? { id: '', sha256: '' },
    environment: runner.environment ?? { snapshotId: '', sha256: '' },
    capability: runner.capability ?? { snapshotId: '', sha256: '' },
    runner,
    fixtures: runner.fixtures ?? { lockSha256: '', sourceHashesValid: false, artifactHashesValid: false },
    scenarios: [{ id: 'preflight', status: decision.status === 'passed' ? 'passed' : 'blocked', attachmentIds: [] }],
    closure: { status: 'closed' },
    manifestSha256: '0'.repeat(64),
  };
  writeReceipt(runId, receiptKey, receipt);
  if (decision.status !== 'passed') {
    console.error(`WINDOWS_PHYSICAL_PRECONDITION_BLOCKED: ${decision.missing?.join(', ')}`);
    process.exit(2);
  }
  console.log(JSON.stringify({ receiptId: receipt.receiptId, receiptKey, status: 'produced' }));
  process.exit(0);
}

if (has('--aggregate-receipts')) {
  const runId = flag('--run');
  const receiptPaths = args.reduce((acc, value, index) => (value === '--receipt' ? [...acc, args[index + 1]] : acc), []);
  if (!runId || receiptPaths.length !== 2) {
    console.error('usage: --aggregate-receipts --run <uuid> --receipt <path> --receipt <path>');
    process.exit(2);
  }
  const receipts = receiptPaths.map(path => JSON.parse(readFileSync(resolve(path), 'utf8')));
  const decision = aggregateGateEReceipts(receipts);
  const dir = join(receiptsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate-e-aggregate.json'), JSON.stringify(decision, null, 2), 'utf8');
  writeFileSync(join(receiptsRoot, 'latest-run.json'), JSON.stringify({ runId, wave: 3, manifestPath: join(dir, 'gate-e-aggregate.json') }, null, 2), 'utf8');
  console.log(JSON.stringify(decision));
  process.exit(decision.status === 'passed' ? 0 : 2);
}

console.error('usage: --produce-receipt | --aggregate-receipts');
process.exit(2);
