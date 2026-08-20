// scripts/resolve-requirement-evidence.ts — W6-01：requirement → evidence 解析 CLI（tsx 运行）
// 用法：node --import tsx scripts/resolve-requirement-evidence.ts --index <index.json> --run <id>
//       --commit <40hex> --artifact-id <id> --artifact-sha256 <64hex>
//       [--requirements docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json]
// 输出事实报告（ok/逐条 issues）；仅当 R01–R20 全部 verified 且证据闭环才 exit 0，否则 exit 3（绝不伪 verified）。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateEvidenceIndex } from '../src/release/evidenceIndexSchema.js';
import { resolveRequirementEvidence } from '../src/release/requirementEvidenceResolver.js';
import type { RequirementCoverage } from '../src/release/requirementSchema.js';

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const indexPath = get('index');
const runId = get('run');
const commit = get('commit');
const artifactId = get('artifact-id');
const artifactSha256 = get('artifact-sha256');
const requirementsPath = get('requirements') ?? 'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json';
const out = get('out') ?? join(dirname(resolve(indexPath ?? '.')), 'requirement-resolution.json');

if (!indexPath || !runId || !commit || !artifactId || !artifactSha256) {
  process.stderr.write('RESOLVE_USAGE: --index <index.json> --run --commit --artifact-id --artifact-sha256 [--requirements] [--out]\n');
  process.exit(2);
}

const requirements = JSON.parse(readFileSync(resolve(requirementsPath), 'utf8')) as RequirementCoverage[];
let rawIndex: unknown;
try {
  rawIndex = JSON.parse(readFileSync(resolve(indexPath), 'utf8')) as unknown;
} catch (cause) {
  process.stderr.write(`RESOLVE_INDEX_MISSING: ${String((cause as Error)?.message ?? cause)}\n`);
  process.exit(2);
}
const validated = validateEvidenceIndex(rawIndex);
const candidate = { runId, commit, artifactId, artifactSha256 };
const resolved = resolveRequirementEvidence(requirements, validated, candidate);

const body = `${JSON.stringify({ ...resolved, candidate, indexFile: indexPath, resolvedAt: new Date().toISOString() }, null, 2)}\n`;
mkdirSync(dirname(resolve(out)), { recursive: true });
const tmp = `${resolve(out)}.tmp`;
writeFileSync(tmp, body, 'utf8');
renameSync(tmp, resolve(out));
rmSync(tmp, { force: true });

console.log(JSON.stringify({ ok: resolved.ok, issues: resolved.issues.length, verified: resolved.perRequirement.filter(r => r.issues.length === 0 && r.status === 'verified').length, out }, null, 2));
// 全 20 条 verified 才 exit 0；否则 incomplete（3）——绝不把不完整证据冒充 verified
process.exit(resolved.ok ? 0 : 3);
