import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { checkRequirementCoverage } from '../src/release/requirementSchema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(
  repoRoot,
  'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json',
);

describe('R01-R20 requirement coverage', () => {
  it('closes requirements, subprojects, scenarios, profiles, platforms, gates and evidence', () => {
    const fixture = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
    const result = checkRequirementCoverage(fixture);

    expect(result.ok, result.issues.join('\n')).toBe(true);
    expect(result.requirementIds).toEqual(
      Array.from({ length: 20 }, (_, index) => `R${String(index + 1).padStart(2, '0')}`),
    );
    expect(result.subprojectIds).toEqual(
      Array.from({ length: 13 }, (_, index) => `S${index + 1}`),
    );
  });
});
