// scripts/import-release-evidence.ts — W6-01：release evidence 索引导入 CLI（tsx 运行）
// 用法：node --import tsx scripts/import-release-evidence.ts --run <id> --commit <40hex> --artifact-id <id>
//       --artifact-sha256 <64hex> [--evidence-root artifacts/release-evidence] [--out <index.json>]
// 只收 passed 门证据 → 索引原子落盘 + 读回校验；exit 0 成功 / 2 导入失败（绝不伪造索引）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importRunEvidence } from '../src/release/evidenceIndexImporter.js';

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const runId = get('run');
const commit = get('commit');
const artifactId = get('artifact-id');
const artifactSha256 = get('artifact-sha256');
const evidenceRoot = get('evidence-root') ?? 'artifacts/release-evidence';
const repoRoot = resolve(process.cwd());
const out = get('out') ?? join(resolve(repoRoot, evidenceRoot), runId ?? 'unknown', 'evidence-index.json');

if (!runId || !commit || !artifactId || !artifactSha256) {
  process.stderr.write('IMPORT_USAGE: --run --commit --artifact-id --artifact-sha256 [--evidence-root] [--out]\n');
  process.exit(2);
}

const result = importRunEvidence({
  evidenceRoot: resolve(repoRoot, evidenceRoot),
  repoRoot,
  runId,
  candidate: { commit, artifactId, artifactSha256 },
});

if (!result.ok) {
  process.stderr.write(`IMPORT_FAILED: ${result.error.code} ${result.error.message ?? ''}\n`);
  process.exit(2);
}

const body = `${JSON.stringify(result.value.index, null, 2)}\n`;
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
writeFileSync(tmp, body, 'utf8');
renameSync(tmp, out);
rmSync(tmp, { force: true });
// 读回自校验：落盘内容逐字节一致（索引绝不自欺）
const readBack = readFileSync(out, 'utf8');
if (readBack !== body) {
  process.stderr.write('IMPORT_READBACK_FAILED\n');
  process.exit(2);
}
const sha256 = createHash('sha256').update(body).digest('hex');
console.log(JSON.stringify({ ok: true, out, runId, entries: result.value.index.evidence.length, indexSha256: sha256 }));
process.exit(0);
