// src/cli/checkReleaseEligibility.ts — W0-02 release eligibility 薄 adapter：
// 只把 persisted gate outcomes 与 known-failure registry 汇入 releaseEligibility，不做本地验收算法。
// 用法：--gates <path> [--required A,B,C,F,G]
// 退出码：0 succeeded / 1 failed / 2 blocked / 3 incomplete / 4 inconclusive / 130 cancelled
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KNOWN_FAILURES } from '../release/knownFailures.js';
import { releaseEligibility, type ReleaseGateOutcome } from '../release/releaseEligibility.js';
import { processExitForCompletion } from '../protocol/completionTransport.js';

const ALL_GATES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

export function checkReleaseEligibility(argv: string[]): number {
  const gatesFlag = argv.indexOf('--gates');
  const gatesPath = gatesFlag >= 0 ? argv[gatesFlag + 1] : undefined;
  if (!gatesPath) {
    process.stderr.write('usage: check-release-eligibility --gates <path> [--required A,B,C,F,G]\n');
    return processExitForCompletion('incomplete');
  }
  const requiredFlag = argv.indexOf('--required');
  const requiredGates = requiredFlag >= 0 && argv[requiredFlag + 1]
    ? argv[requiredFlag + 1]!.split(',').map(item => item.trim()).filter(Boolean)
    : ALL_GATES;

  const full = resolve(gatesPath);
  if (!existsSync(full)) {
    process.stdout.write(`${JSON.stringify({ status: 'incomplete', code: 'RELEASE_GATE_OUTCOME_MISSING', reasons: ['RELEASE_GATE_OUTCOME_MISSING'] })}\n`);
    return processExitForCompletion('incomplete');
  }

  let outcomes: ReleaseGateOutcome[];
  try {
    const raw = JSON.parse(readFileSync(full, 'utf8')) as unknown;
    outcomes = (Array.isArray(raw) ? raw : []).map(item => {
      const row = item as Record<string, unknown>;
      return { gate: String(row.gate ?? ''), status: String(row.status ?? '') };
    });
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'inconclusive', code: 'RELEASE_GATE_OUTCOMES_INVALID', reasons: ['RELEASE_GATE_OUTCOMES_INVALID'] })}\n`);
    return processExitForCompletion('inconclusive');
  }

  // resolved 条目的 green regression 必须在盘上存在，否则不可判定（不把 oracle 绿误当修复证据）
  const missingRegressions = KNOWN_FAILURES
    .filter(entry => entry.status === 'resolved-with-green-regression' && !existsSync(resolve(entry.regressionFile)))
    .map(entry => entry.id);
  if (missingRegressions.length > 0) {
    process.stdout.write(`${JSON.stringify({ status: 'inconclusive', code: 'RELEASE_RESOLVED_KF_REGRESSION_MISSING', reasons: missingRegressions.map(id => `RELEASE_RESOLVED_KF_REGRESSION_MISSING:${id}`) })}\n`);
    return processExitForCompletion('inconclusive');
  }

  const openBlockers = KNOWN_FAILURES.filter(entry => entry.status === 'open').map(entry => entry.id);
  const result = releaseEligibility({ requiredGates, outcomes, openBlockers });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return processExitForCompletion(result.status);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = checkReleaseEligibility(process.argv.slice(2));
}
