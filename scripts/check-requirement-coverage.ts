// scripts/check-requirement-coverage.ts — R01-R20/S1-S13 覆盖检查
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequirementCoverage } from '../src/release/requirementSchema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json');

let raw: string;
try {
  raw = readFileSync(sourcePath, 'utf8');
} catch (e) {
  console.error(`REQUIREMENTS_MISSING:${sourcePath}: ${String(e)}`);
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`REQUIREMENTS_PARSE_FAILED:${sourcePath}: ${String(e)}`);
  process.exit(1);
}

const result = checkRequirementCoverage(parsed);
if (!result.ok) {
  console.error(`REQUIREMENT_COVERAGE_FAILED:${sourcePath}`);
  for (const issue of result.issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log(`REQUIREMENT_COVERAGE_OK:${result.requirementIds.length} requirements, ${result.subprojectIds.length} subprojects`);
