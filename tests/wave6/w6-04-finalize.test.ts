// tests/wave6/w6-04-finalize.test.ts — W6-04 契约：release:finalize 固定顺序 + 诚实失败 + 绝不发布（RED → 实现后全绿）
// 源检：finalize/freeze 源码不得含发布命令（npm publish/git tag/git push——唯一 operator-facing 命令不发布）。
// 决策：索引缺失/候选漂移/E blocked/H-I 未过/需求未 verified/eligibility 或 completion gate 非零 → 各自 blocked；
// 全链路通过才写 success-certificate；步骤顺序固定且可审计。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finalizeRelease, type FinalizeSpawn, type FinalizeResult } from '../../src/release/finalizeRelease.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const COMMIT = 'a'.repeat(40);

interface RunFixture {
  repoRoot: string;
  evidenceRoot: string;
  runId: string;
  candidateFile: string;
}

/** 全绿 run 目录：gate-report 全 0（含 F-W3）、E aggregate passed、H/I outcomes passed、candidate 一致 */
function makeRun(repoRoot: string): RunFixture {
  const evidenceRoot = join(repoRoot, 'artifacts', 'release-evidence');
  const runId = 'run-w6-04';
  const runDir = join(evidenceRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'gate-report.json'), JSON.stringify({
    runId, wave: 3, firstFailure: null,
    gates: { 'A-W3': 0, 'B-W3': 0, 'C-W3': 0, 'D-W3': 0, 'E-W3': 0, 'F-W3': 0, 'G-W3': 0 },
  }, null, 2));
  writeFileSync(join(runDir, 'gate-e-aggregate.json'), JSON.stringify({ status: 'passed', receiptIds: ['r1', 'r2'] }, null, 2));
  mkdirSync(join(runDir, 'gate-h'), { recursive: true });
  writeFileSync(join(runDir, 'gate-h', 'outcome.json'), JSON.stringify({ gate: 'H', runId, status: 'passed', steps: [] }, null, 2));
  mkdirSync(join(runDir, 'gate-i'), { recursive: true });
  writeFileSync(join(runDir, 'gate-i', 'outcome.json'), JSON.stringify({ gate: 'I', runId, status: 'passed' }, null, 2));
  const candidateFile = join(runDir, 'candidate.json');
  writeFileSync(candidateFile, JSON.stringify({
    candidateId: 'cand-test', commit: COMMIT, tgzSha256: 'b'.repeat(64),
    cell: { os: process.platform, arch: process.arch, node: process.version }, entrypoint: 'dist/cli/index.js', dynamicImportDeclarations: [],
  }, null, 2));
  // import 步骤产物（evidence index——finalizer 校验存在性）
  writeFileSync(join(runDir, 'evidence-index.json'), JSON.stringify({
    schemaVersion: 1,
    candidate: { runId, commit: COMMIT, artifactId: 'cand-test', artifactSha256: 'b'.repeat(64) },
    evidence: [],
  }, null, 2));
  return { repoRoot, evidenceRoot, runId, candidateFile };
}

/** 全绿 spawn 假件：顺序记录 + 每步成功（pack 重算返回与 candidate 一致的哈希） */
function greenSpawn(): { spawn: FinalizeSpawn; calls: string[] } {
  const calls: string[] = [];
  const spawn: FinalizeSpawn = (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (args.includes('pack')) return { status: 0, stdout: `sha256=${'b'.repeat(64)}` };
    return { status: 0, stdout: '{"ok":true}' };
  };
  return { spawn, calls };
}

describe('W6-04 release:finalize', () => {
  it('源检：finalize 与 freeze 源码绝不包含发布命令（npm publish/git tag/git push）', () => {
    for (const file of ['scripts/finalize-release.ts', 'src/release/finalizeRelease.ts', 'src/release/candidateFreezer.ts', 'scripts/freeze-candidate.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} 不得含发布命令`).not.toMatch(/npm\s+publish|git\s+tag|git\s+push/);
    }
  });

  it('全链路通过 → succeeded + success-certificate 落盘；步骤顺序固定可审计', async () => {
    const repoRoot = tmp('w6-fin-ok-');
    const fixture = makeRun(repoRoot);
    const { spawn, calls } = greenSpawn();
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile,
      requirementsFile: join(repoRoot, 'requirements.json'),
      spawn,
    });
    expect(result.result.status).toBe('succeeded');
    expect(result.result.certificatePath).toBeTruthy();
    if (result.result.certificatePath) expect(existsSync(result.result.certificatePath)).toBe(true);
    // 固定顺序：import → coverage → pack 重算 → eligibility → completion（按 spawn 调用序列审计）
    const stepOrder = calls.join('>');
    const importIndex = stepOrder.indexOf('import');
    const packIndex = stepOrder.indexOf('pack');
    const eligibilityIndex = stepOrder.indexOf('eligibility');
    const completionIndex = stepOrder.indexOf('completion');
    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(packIndex).toBeGreaterThan(importIndex);
    expect(eligibilityIndex).toBeGreaterThan(packIndex);
    expect(completionIndex).toBeGreaterThan(eligibilityIndex);
  });

  it('候选漂移（重算 tgz sha256 ≠ candidate.tgzSha256）→ blocked RELEASE_CANDIDATE_DRIFT', async () => {
    const repoRoot = tmp('w6-fin-drift-');
    const fixture = makeRun(repoRoot);
    const spawn: FinalizeSpawn = (command: string, args: string[]) => {
      if (args.includes('pack')) return { status: 0, stdout: 'sha256=ffffffff' };
      return { status: 0, stdout: '{}' };
    };
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'), spawn,
    });
    expect(result.result.status).toBe('blocked');
    expect(result.result.steps.find((step: { code?: string }) => step.code === 'RELEASE_CANDIDATE_DRIFT')).toBeTruthy();
    expect(result.result.certificatePath).toBeUndefined();
  });

  it('Gate E blocked 传导 → blocked；无 certificate', async () => {
    const repoRoot = tmp('w6-fin-eblock-');
    const fixture = makeRun(repoRoot);
    writeFileSync(join(fixture.evidenceRoot, fixture.runId, 'gate-e-aggregate.json'), JSON.stringify({ status: 'blocked', code: 'WINDOWS_RECEIPT_CORE_MISMATCH' }, null, 2));
    const { spawn } = greenSpawn();
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'), spawn,
    });
    expect(result.result.status).toBe('blocked');
    expect(result.result.steps.find((step: { code?: string }) => step.code === 'RELEASE_GATE_E_BLOCKED')).toBeTruthy();
    expect(result.result.certificatePath).toBeUndefined();
  });

  it('completion gate 非零 → blocked；需求解析非零 → blocked；索引缺失 → blocked', async () => {
    const repoRoot = tmp('w6-fin-fails-');
    const fixture = makeRun(repoRoot);
    // completion gate 非零
    let spawn: FinalizeSpawn = (command: string, args: string[]) => {
      if (args.includes('pack')) return { status: 0, stdout: `sha256=${'b'.repeat(64)}` };
      if (args.join(' ').includes('completion')) return { status: 2, stdout: '{"status":"blocked"}' };
      return { status: 0, stdout: '{}' };
    };
    let result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'), spawn,
    });
    expect(result.result.status).toBe('blocked');
    expect(result.result.steps.find((step: { code?: string }) => step.code === 'RELEASE_COMPLETION_GATE_FAILED')).toBeTruthy();
    // 需求解析非零（resolve exit 3）
    spawn = (command: string, args: string[]) => {
      if (args.includes('pack')) return { status: 0, stdout: `sha256=${'b'.repeat(64)}` };
      if (args.join(' ').includes('resolve-requirement-evidence')) return { status: 3, stdout: '{"ok":false}' };
      return { status: 0, stdout: '{}' };
    };
    result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'), spawn,
    });
    expect(result.result.status).toBe('blocked');
    expect(result.result.steps.find((step: { code?: string }) => step.code === 'RELEASE_REQUIREMENT_COVERAGE_BLOCKED')).toBeTruthy();
    // 索引缺失（import 产物不存在 → import 步骤 blocked）
    const bareRepo = tmp('w6-fin-noidx-');
    const bareFixture = makeRun(bareRepo);
    rmSync(join(bareFixture.evidenceRoot, bareFixture.runId, 'evidence-index.json'), { force: true });
    spawn = greenSpawn().spawn;
    result = await finalizeRelease({
      repoRoot: bareRepo, evidenceRoot: bareFixture.evidenceRoot, runId: bareFixture.runId,
      candidateFile: bareFixture.candidateFile, requirementsFile: join(bareRepo, 'requirements.json'), spawn,
    });
    expect(result.result.status).toBe('blocked');
    expect(result.result.steps.find((step: { code?: string }) => step.code === 'RELEASE_EVIDENCE_IMPORT_FAILED')).toBeTruthy();
  });

  it('事实报告：rootDigest 与步骤状态落盘（finalize-report.json）', async () => {
    const repoRoot = tmp('w6-fin-report-');
    const fixture = makeRun(repoRoot);
    writeFileSync(join(fixture.evidenceRoot, fixture.runId, 'gate-e-aggregate.json'), JSON.stringify({ status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED' }, null, 2));
    const { spawn } = greenSpawn();
    const result = await finalizeRelease({
      repoRoot, evidenceRoot: fixture.evidenceRoot, runId: fixture.runId,
      candidateFile: fixture.candidateFile, requirementsFile: join(repoRoot, 'requirements.json'), spawn,
    });
    const report = JSON.parse(readFileSync(join(fixture.evidenceRoot, fixture.runId, 'finalize-report.json'), 'utf8')) as Record<string, unknown>;
    expect(report.status).toBe('blocked');
    expect(report.rootDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Array.isArray(report.steps)).toBe(true);
    void result;
  });

  // W8-16（实盘缺陷）：run-wave3-gates 曾写 {status} 对象 → importer 全跳过（entries=0）+ F-W3 永不为 0。
  // 生产者 gates 必须是数字状态码 map（0/1/2/3/4/130），细节保留在 details——与 importer/finalize 契约一致。
  it('源锚点：run-wave3-gates 产出数字状态码 gates（与 importer/finalize 契约 schema 一致）', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'scripts', 'run-wave3-gates.mjs'), 'utf8');
    expect(src).toContain('gates: gateStatuses');
    expect(src).toContain('details: gateResults');
    expect(src).toContain('r.status');
  });
});
