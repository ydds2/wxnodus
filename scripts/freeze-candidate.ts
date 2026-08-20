// scripts/freeze-candidate.ts — W6-04：发布候选冻结入口（tsx 运行）——pack:release 唯一 candidate builder，绝不发布
// 用法：node --import tsx scripts/freeze-candidate.ts --run <runId> [--repo-root .]
// 产出：artifacts/release-evidence/<runId>/candidate.json + <tgz>（tgz sha256 绑定）
import { resolve } from 'node:path';
import { freezeCandidate } from '../src/release/candidateFreezer.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const runId = flag('run');
const repoRoot = resolve(flag('repo-root') ?? '.');
if (!runId) {
  process.stderr.write('FREEZE_USAGE: --run <runId> [--repo-root <path>]\n');
  process.exit(2);
}

const result = await freezeCandidate({
  repoRoot,
  runId,
  outDir: resolve(repoRoot, 'artifacts', 'release-evidence', runId),
});
if (!result.ok) {
  process.stderr.write(`FREEZE_FAILED: ${result.error.code} ${result.error.message ?? ''}\n`);
  process.exit(2);
}
console.log(JSON.stringify({
  ok: true, candidateId: result.value.candidateId, commit: result.value.commit,
  tgzSha256: result.value.tgzSha256, sbomSha256: result.value.sbomSha256, distTreeSha256: result.value.distTreeSha256,
  candidateFile: result.value.candidateFile, sbomFile: result.value.sbomFile, tgzFile: result.value.tgzFile,
  cell: result.value.cell,
}, null, 2));
process.exit(0);
