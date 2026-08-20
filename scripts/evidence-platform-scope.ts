// scripts/evidence-platform-scope.ts — Gate I windows-only 档的平台范围证据（W6-09 用户决策）
// 产出 artifacts/release-evidence/<runId>/platform-scope/outcome.json：
//   { scope: 'windows-only', waivedCells: <六个 canonical 非 Windows cells>, waiverReason, ts }
// 聚合方（aggregateGateIReceipts --scope windows-only）逐字校验 waivedCells 与 canonical 闭包相等；
// 文件缺失/内容不符 → GATE_I_WAIVER_EVIDENCE_MISSING / GATE_I_WAIVER_MISMATCH（fail-closed）。
// 用法：node scripts/evidence-platform-scope.mjs --run <runId>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_NON_WINDOWS_CELLS } from '../src/release/gateI.js';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const runId = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : '';
if (!runId) {
  console.error('USAGE: node scripts/evidence-platform-scope.mjs --run <runId>');
  process.exit(2);
}
const outDir = join(ROOT, 'artifacts', 'release-evidence', runId, 'platform-scope');
mkdirSync(outDir, { recursive: true });
const outcome = {
  scope: 'windows-only',
  waivedCells: [...CANONICAL_NON_WINDOWS_CELLS],
  waiverReason: '产品定位 Windows 本地优先（用户决策，2026-08-16）——从始至终只做 Windows 本地 CLI；非 Windows cells 声明性豁免，仅 Windows 已验证',
  ts: new Date().toISOString(),
};
const file = join(outDir, 'outcome.json');
writeFileSync(file, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(outcome, null, 2));
console.log(`written: ${file}`);
process.exit(0);
