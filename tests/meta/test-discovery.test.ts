import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(repoRoot, 'scripts/check-test-discovery.mjs');

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, '--json', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('workspace test discovery', () => {
  it('exactly matches every disk-required test to Vitest resolved files', () => {
    const fixture = run();
    expect(fixture.status, fixture.stderr || fixture.stdout).toBe(0);
    const report = JSON.parse(fixture.stdout) as {
      roots: Array<{ path: string }>;
      diskRequiredFiles: string[];
      vitestResolvedFiles: string[];
      missingFiles: string[];
      unexpectedFiles: string[];
      excludedRequiredFiles: string[];
      missingRequiredRoots: string[];
      errorCode: string | null;
    };

    expect(report.roots.map(root => root.path)).toEqual(['tests', 'src', 'packages']);
    expect(report.vitestResolvedFiles).toEqual(report.diskRequiredFiles);
    expect(report.missingFiles).toEqual([]);
    expect(report.unexpectedFiles).toEqual([]);
    expect(report.excludedRequiredFiles).toEqual([]);
    expect(report.missingRequiredRoots).toEqual([]);
    expect(report.errorCode).toBeNull();
  });

  it('fails when an otherwise-required test is excluded by Vitest', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'wxn-discovery-excluded-'));
    try {
      mkdirSync(resolve(fixtureRoot, 'tests/excluded'), { recursive: true });
      mkdirSync(resolve(fixtureRoot, 'src'), { recursive: true });
      mkdirSync(resolve(fixtureRoot, 'packages'), { recursive: true });
      writeFileSync(resolve(fixtureRoot, 'tests/included.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'tests/excluded/required.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'src/co-located.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'packages/package.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'vitest.config.ts'), [
        "export default { test: { include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'packages/**/*.test.ts'], exclude: ['tests/excluded/**'] } };",
      ].join('\n'));

      const fixture = run('--repo-root', fixtureRoot);
      expect(fixture.status).toBe(1);
      const report = JSON.parse(fixture.stdout) as {
        excludedRequiredFiles: string[];
        errorCode: string | null;
      };
      expect(report.excludedRequiredFiles).toEqual(['tests/excluded/required.test.ts']);
      expect(report.errorCode).toBe('TEST_DISCOVERY_SET_MISMATCH');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
