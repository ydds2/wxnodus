// scripts/finalize-release.ts — W6-04：唯一 operator-facing release 终局入口（tsx 运行）
// 用法：node --import tsx scripts/finalize-release.ts --run <runId> [--candidate <candidate.json>]
//       [--requirements <requirements.json>] [--evidence-root artifacts/release-evidence]
// 顺序固定；任何 blocked 非零退出（2）；全过 exit 0。绝不重建 candidate、绝不 publish/tag/release。
import { resolve } from 'node:path';
import { finalizeRelease } from '../src/release/finalizeRelease.js';
import { processExitForCompletion } from '../src/protocol/completionTransport.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const runId = flag('run');
const repoRoot = resolve(flag('repo-root') ?? '.');
const evidenceRoot = resolve(repoRoot, flag('evidence-root') ?? 'artifacts/release-evidence');
if (!runId) {
  process.stderr.write('FINALIZE_USAGE: --run <runId> [--candidate <candidate.json>] [--requirements <path>]\n');
  process.exit(2);
}
const runDir = resolve(evidenceRoot, runId);
const candidateFile = resolve(flag('candidate') ?? `${runDir}/candidate.json`);
const requirementsFile = resolve(flag('requirements') ?? 'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json');
// W6-05：--scope windows|all（缺省 windows——只需在 Windows 上跑；all 才要求跨平台 Gate I）
const scope = flag('scope') as 'windows' | 'all' | undefined;

const { result } = await finalizeRelease({ repoRoot, evidenceRoot, runId, candidateFile, requirementsFile, ...(scope ? { scope } : {}) });
console.log(JSON.stringify(result, null, 2));
process.exit(processExitForCompletion(result.status));
