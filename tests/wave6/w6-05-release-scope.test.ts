// tests/wave6/w6-05-release-scope.test.ts — W6-05 契约：发布范围（Windows-only 产品定位）
// 用户决策：只需在 Windows 上跑——跨平台 Gate I 退出必选范围（仍保留机制，all 范围时照常要求）。
// 契约：resolveReleaseScope 缺省 windows；requiredReleaseGates(windows) 无 I；
// finalizer windows 范围下 Gate I 缺失不阻断 gate-digests；all 范围行为不变（缺失即 blocked）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReleaseScope, requiredReleaseGates } from '../../src/release/releaseScope.js';
import { finalizeRelease, type FinalizeSpawn } from '../../src/release/finalizeRelease.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const COMMIT = 'a'.repeat(40);

function makeRun(repoRoot: string) {
  const evidenceRoot = join(repoRoot, 'artifacts', 'release-evidence');
  const runId = 'run-w6-05';
  const runDir = join(evidenceRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'gate-report.json'), JSON.stringify({
    runId, wave: 3, firstFailure: null,
    gates: { 'A-W3': 0, 'B-W3': 0, 'C-W3': 0, 'D-W3': 0, 'E-W3': 0, 'F-W3': 0, 'G-W3': 0 },
  }, null, 2));
  writeFileSync(join(runDir, 'gate-e-aggregate.json'), JSON.stringify({ status: 'passed', receiptIds: ['r1', 'r2'] }, null, 2));
  mkdirSync(join(runDir, 'gate-h'), { recursive: true });
  writeFileSync(join(runDir, 'gate-h', 'outcome.json'), JSON.stringify({ gate: 'H', runId, status: 'passed', steps: [] }, null, 2));
  // 注意：gate-i 目录刻意不创建——测试范围语义
  const candidateFile = join(runDir, 'candidate.json');
  writeFileSync(candidateFile, JSON.stringify({
    candidateId: 'cand-test', commit: COMMIT, tgzSha256: 'b'.repeat(64),
    cell: { os: process.platform, arch: process.arch, node: process.version }, entrypoint: 'dist/cli/index.js', dynamicImportDeclarations: [],
  }, null, 2));
  writeFileSync(join(runDir, 'evidence-index.json'), JSON.stringify({
    schemaVersion: 1,
    candidate: { runId, commit: COMMIT, artifactId: 'cand-test', artifactSha256: 'b'.repeat(64) },
    evidence: [],
  }, null, 2));
  return { repoRoot, evidenceRoot, runId, candidateFile };
}

const greenSpawn = (): { spawn: FinalizeSpawn; calls: string[] } => {
  const calls: string[] = [];
  const spawn: FinalizeSpawn = (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (args.includes('pack')) return { status: 0, stdout: `sha256=${'b'.repeat(64)}` };
    return { status: 0, stdout: '{"ok":true}' };
  };
  return { spawn, calls };
};

describe('W6-05 release scope（Windows-only 定位）', () => {
  it('resolveReleaseScope：缺省/未知 → windows；显式 all → all', () => {
    expect(resolveReleaseScope(undefined)).toBe('windows');
    expect(resolveReleaseScope('windows')).toBe('windows');
    expect(resolveReleaseScope('bogus')).toBe('windows');
    expect(resolveReleaseScope('all')).toBe('all');
  });

  it('requiredReleaseGates：windows 无 Gate I；all 含 Gate I', () => {
    expect(requiredReleaseGates('windows')).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(requiredReleaseGates('all')).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  });

  it('windows 范围：Gate I 缺失不阻断 gate-digests，eligibility 必选表不含 I', async () => {
    const repoRoot = tmp('w6-scope-win-');
    const fixture = makeRun(repoRoot);
    const { spawn, calls } = greenSpawn();
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'),
      spawn, scope: 'windows',
    });
    expect(result.result.status).toBe('succeeded');
    expect(result.result.steps.find(s => s.step === 'gate-digests')?.status).toBe('passed');
    const eligibility = calls.find(c => c.includes('eligibility')) ?? '';
    expect(eligibility).toContain('--required');
    expect(eligibility).toContain('A,B,C,D,E,F,G,H');
    expect(eligibility).not.toContain('A,B,C,D,E,F,G,H,I');
  });

  it('all 范围：Gate I 缺失 → blocked RELEASE_GATE_I_NOT_PASSED（原行为保持）', async () => {
    const repoRoot = tmp('w6-scope-all-');
    const fixture = makeRun(repoRoot);
    const { spawn } = greenSpawn();
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'),
      spawn, scope: 'all',
    });
    expect(result.result.status).toBe('blocked');
    expect(result.result.steps.find((s: { code?: string }) => s.code === 'RELEASE_GATE_I_NOT_PASSED')).toBeTruthy();
    expect(result.result.certificatePath).toBeUndefined();
  });

  it('缺省范围即 windows（产品决策落码——不传 scope 与显式 windows 等价）', async () => {
    const repoRoot = tmp('w6-scope-default-');
    const fixture = makeRun(repoRoot);
    const { spawn } = greenSpawn();
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'),
      spawn,
    });
    expect(result.result.status).toBe('succeeded');
    expect(existsSync(join(fixture.evidenceRoot, fixture.runId, 'finalize-report.json'))).toBe(true);
  });
});
