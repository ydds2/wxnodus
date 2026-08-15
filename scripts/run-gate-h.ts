// scripts/run-gate-h.ts — W6-03：Gate H 发行边界离线证据运行入口（tsx 运行）
// 用法：node --import tsx scripts/run-gate-h.ts --run <runId> [--candidate <candidate.json>]
// 产出：artifacts/release-evidence/<runId>/gate-h/{outcome.json + attachments/*}；全 passed 才 exit 0。
import { resolve } from 'node:path';
import { runGateH } from '../src/release/gateHRunner.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const runId = flag('run');
const repoRoot = resolve(flag('repo-root') ?? '.');
if (!runId) {
  process.stderr.write('GATE_H_USAGE: --run <runId> [--candidate <candidate.json>]\n');
  process.exit(2);
}
const runDir = resolve(repoRoot, 'artifacts', 'release-evidence', runId);
const candidateFile = resolve(flag('candidate') ?? `${runDir}/candidate.json`);

const cacheSeed = flag('cache-seed') ? resolve(flag('cache-seed')!) : undefined;
const result = await runGateH({ repoRoot, evidenceDir: resolve(runDir, 'gate-h'), runId, candidateFile, ...(cacheSeed ? { cacheSeed } : {}) });
if (!result.ok) {
  process.stderr.write(`GATE_H_FAILED: ${result.error.code} ${result.error.message ?? ''}\n`);
  process.exit(2);
}
const outcome = result.value;
console.log(JSON.stringify({ gate: 'H', status: outcome.status, steps: outcome.steps.map(s => ({ id: s.id, status: s.status, reason: s.reason })) }, null, 2));
process.exit(outcome.status === 'passed' ? 0 : 2);
