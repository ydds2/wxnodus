import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  KNOWN_FAILURES,
  validateKnownFailureRegistry,
} from '../../src/release/knownFailures.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const vitestCli = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');

const registry = validateKnownFailureRegistry(KNOWN_FAILURES);
if (!registry.ok) throw new Error(registry.issues.join('\n'));
const entries = registry.entries;

describe('known V3 failure registry', () => {
  it('has exact disk closure: every active case belongs to exactly one open ID', () => {
    const diskCases = readdirSync(resolve(repoRoot, 'tests/known-failures/cases'))
      .filter(name => name.endsWith('.case.ts'))
      .map(name => `tests/known-failures/cases/${name}`)
      .sort();
    const registeredCases = entries
      .filter(entry => entry.status === 'open')
      .map(entry => entry.caseFile)
      .sort();
    expect(diskCases).toEqual(registeredCases);
  });

  for (const failure of entries) {
    if (failure.status === 'open') {
      it(`${failure.id} open oracle emits its stable failure code`, () => {
        const fixture = spawnSync(process.execPath, [tsxCli, resolve(repoRoot, failure.caseFile)], {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: failure.timeoutMs,
        });
        expect(fixture.status, `${failure.id} unexpectedly passed\n${fixture.stdout}`).toBe(1);
        const line = fixture.stderr.trim().split(/\r?\n/).at(-1) ?? '';
        const report = JSON.parse(line) as { failureId: string; failureCode: string };
        expect(report.failureId).toBe(failure.id);
        expect(report.failureCode).toBe(failure.expectedFailureCode);
      });
    } else {
      it(`${failure.id} resolved regression is an ordinary green test`, () => {
        expect(existsSync(resolve(repoRoot, failure.regressionFile))).toBe(true);
        const fixture = spawnSync(process.execPath, [
          vitestCli, 'run', '--config', resolve(repoRoot, 'vitest.config.ts'), failure.regressionFile,
        ], { cwd: repoRoot, encoding: 'utf8', timeout: failure.timeoutMs });
        expect(fixture.status, fixture.stderr || fixture.stdout).toBe(0);
        const retiredCasePrefix = `${failure.id.toLowerCase()}-`;
        expect(readdirSync(resolve(repoRoot, 'tests/known-failures/cases'))
          .some(name => name.startsWith(retiredCasePrefix) && name.endsWith('.case.ts'))).toBe(false);
      });
    }
  }
});
