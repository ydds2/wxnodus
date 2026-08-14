// scripts/check-release-surface.mjs — W6-04：release 面预检（finalize 的 dry-run 前置门）
// 检查：candidate 冻结文件存在且字段合法、evidence index 存在、gate-report/E/H/I 产物存在、requirements 文件存在。
// 全部齐备 → exit 0；任一缺失 → 事实报告 + exit 2（blocked）。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runId = flag('run');
if (!runId) {
  console.error('SURFACE_USAGE: --run <runId>');
  process.exit(2);
}
const runDir = join(ROOT, 'artifacts', 'release-evidence', runId);
const checks = [
  ['candidate.json', join(runDir, 'candidate.json')],
  ['evidence-index.json', join(runDir, 'evidence-index.json')],
  ['gate-report.json', join(runDir, 'gate-report.json')],
  ['gate-e-aggregate.json', join(runDir, 'gate-e-aggregate.json')],
  ['gate-h/outcome.json', join(runDir, 'gate-h', 'outcome.json')],
  ['gate-i/outcome.json', join(runDir, 'gate-i', 'outcome.json')],
  ['requirements', join(ROOT, 'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json')],
];
const missing = [];
for (const [name, file] of checks) {
  if (!existsSync(file)) { missing.push(name); continue; }
  if (name === 'candidate.json') {
    try {
      const candidate = JSON.parse(readFileSync(file, 'utf8'));
      if (!/^[a-f0-9]{40}$/.test(candidate.commit) || !/^[a-f0-9]{64}$/.test(candidate.tgzSha256)) missing.push(`${name} (字段非法)`);
    } catch { missing.push(`${name} (不可解析)`); }
  }
}
console.log(JSON.stringify({ runId, complete: missing.length === 0, missing }, null, 2));
process.exit(missing.length === 0 ? 0 : 2);
