// scripts/run-gate-i.ts — W6-03：Gate I 跨平台验收入口（tsx 运行）
// --produce-receipt：真实 worker（linux/macos）跑 headless E2E + receipt；本机 → GATE_I_PLATFORM_UNAVAILABLE（exit 2）
// --aggregate-receipts --receipt <dir> [--receipt <dir>]：receipt 校验聚合
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { produceGateIReceipt, aggregateGateIReceipts } from '../src/release/gateI.js';

const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(name);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const repoRoot = resolve(flag('--repo-root') ?? '.');

if (has('--produce-receipt')) {
  const runId = flag('--run');
  if (!runId) {
    process.stderr.write('GATE_I_USAGE: --produce-receipt --run <runId>\n');
    process.exit(2);
  }
  const evidenceDir = resolve(repoRoot, 'artifacts', 'release-evidence', runId, 'gate-i');
  const result = await produceGateIReceipt({ repoRoot, evidenceDir, runId });
  if (!result.ok) {
    process.stderr.write(`GATE_I_FAILED: ${result.error.code}\n`);
    process.exit(2);
  }
  const body = `${JSON.stringify(result.value, null, 2)}\n`;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(resolve(evidenceDir, 'outcome.json'), body, 'utf8');
  console.log(JSON.stringify(result.value));
  process.exit(result.value.status === 'passed' ? 0 : 2);
}

if (has('--aggregate-receipts')) {
  const receiptDirs = args.reduce((acc: string[], value, index) => (value === '--receipt' ? [...acc, args[index + 1]!] : acc), []);
  if (receiptDirs.length === 0) {
    process.stderr.write('GATE_I_USAGE: --aggregate-receipts --receipt <dir> [--receipt <dir>]\n');
    process.exit(2);
  }
  const decision = aggregateGateIReceipts(receiptDirs.map(dir => resolve(dir)));
  console.log(JSON.stringify(decision));
  process.exit(decision.status === 'passed' ? 0 : 2);
}

process.stderr.write('GATE_I_USAGE: --produce-receipt | --aggregate-receipts\n');
process.exit(2);
