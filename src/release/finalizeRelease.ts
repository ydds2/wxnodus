// src/release/finalizeRelease.ts — W6-04：唯一 operator-facing release 终局编排（release:finalize）
// 固定顺序：import evidence → legacy reachability → requirement coverage → 读 immutable candidate → report
// → recompute hashes（真实 npm pack 重算 tgz sha256，漂移 → RELEASE_CANDIDATE_DRIFT）→ 比对 E/H/I digest
// → release gate（check-release-eligibility）→ completion gate（run-completion-gate）。
// 全链路通过才写 success-certificate；任何 blocked 只出事实报告。绝不重建 candidate、绝不 publish/tag/release。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReleaseScope, requiredReleaseGates, type ReleaseScope } from './releaseScope.js';

export type FinalizeSpawn = (command: string, args: string[], opts?: { cwd?: string }) => { status: number | null; stdout: string };

export interface FinalizeStepResult {
  step: string;
  status: 'passed' | 'blocked' | 'incomplete';
  code?: string;
}

export interface FinalizeResult {
  status: 'succeeded' | 'failed' | 'blocked' | 'incomplete' | 'inconclusive';
  steps: FinalizeStepResult[];
  rootDigest: string;
  certificatePath?: string;
}

export interface FinalizeReleaseOptions {
  repoRoot: string;
  evidenceRoot: string;
  runId: string;
  candidateFile: string;
  requirementsFile: string;
  /** W6-05 发布范围：缺省 windows（用户决策——只需在 Windows 上跑）；all 才要求跨平台 Gate I */
  scope?: ReleaseScope;
  spawn?: FinalizeSpawn;
  now?: () => string;
}

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

const readJsonSafe = (file: string): Record<string, unknown> | null => {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

const writeJsonAtomic = (file: string, value: unknown): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(`${file}.tmp`, file);
  rmSync(`${file}.tmp`, { force: true });
};

const buildGateOutcomes = (
  gateReport: { gates?: Record<string, number> } | null,
  eAggregate: Record<string, unknown> | null,
  hOutcome: Record<string, unknown> | null,
  iOutcome: Record<string, unknown> | null,
  scope: ReleaseScope,
): Array<{ gate: string; status: string }> => {
  const codeToStatus = (code: number): string => code === 0 ? 'passed' : code === 1 ? 'failed' : code === 2 ? 'blocked' : code === 3 ? 'incomplete' : code === 4 ? 'inconclusive' : 'cancelled';
  const outcomes: Array<{ gate: string; status: string }> = [];
  for (const [gateId, code] of Object.entries(gateReport?.gates ?? {})) {
    outcomes.push({ gate: gateId.replace(/-W\d$/, ''), status: codeToStatus(code) });
  }
  if (eAggregate) outcomes.push({ gate: 'E', status: eAggregate.status === 'passed' ? 'passed' : 'blocked' });
  if (hOutcome) outcomes.push({ gate: 'H', status: hOutcome.status === 'passed' ? 'passed' : 'blocked' });
  if (scope === 'all') {
    if (iOutcome) outcomes.push({ gate: 'I', status: iOutcome.status === 'passed' ? 'passed' : 'blocked' });
  } else {
    // W6-05 Windows-only 范围：Gate I 不适用（跨平台验收退出必选——用户决策落码）
    outcomes.push({ gate: 'I', status: 'not_applicable' });
  }
  return outcomes;
};

export async function finalizeRelease(options: FinalizeReleaseOptions): Promise<{ result: FinalizeResult; report: Record<string, unknown> }> {
  const { repoRoot, evidenceRoot, runId, candidateFile } = options;
  const scope = resolveReleaseScope(options.scope);
  const now = options.now ?? (() => new Date().toISOString());
  const runDir = join(evidenceRoot, runId);
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const defaultSpawn: FinalizeSpawn = (command, args, opts) => {
    // W8-17（实盘缺陷）：win32 上 shell:true 会把含空格的 execPath（C:\Program Files\nodejs\node.exe）
    // 不加引号拼进 cmd 行 → cmd 报 'C:\Program' 不是命令 → import/coverage spawn 恒失败。
    // node 直 spawn 不需要 shell；只有 .cmd/.bat（npm.cmd）需要 shell 解析。
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const result = spawnSync(command, args, {
      cwd: opts?.cwd ?? repoRoot, encoding: 'utf8', stdio: 'pipe', shell: useShell,
      timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: String(result.stdout ?? '') };
  };
  const spawn = options.spawn ?? defaultSpawn;
  const spawnTsx = (script: string, args: string[]) => spawn(process.execPath, [tsx, script, ...args]);
  const steps: FinalizeStepResult[] = [];
  const push = (step: string, status: FinalizeStepResult['status'], code?: string) => { steps.push({ step, status, ...(code ? { code } : {}) }); };

  // 前置读取 immutable candidate（import 步骤需要其绑定三元组；步骤 4 做正式校验——绝不重建）
  let candidate: { candidateId: string; commit: string; tgzSha256: string; entrypoint?: string; cell?: Record<string, string> } | undefined;
  try {
    candidate = JSON.parse(readFileSync(candidateFile, 'utf8')) as typeof candidate;
  } catch { candidate = undefined; }

  const finish = (): { result: FinalizeResult; report: Record<string, unknown> } => {
    const status: FinalizeResult['status'] = steps.every(step => step.status === 'passed')
      ? 'succeeded'
      : steps.some(step => step.status === 'blocked') ? 'blocked' : 'incomplete';
    const completedAt = now();
    const rootDigest = sha256(JSON.stringify({ runId, candidateId: candidate?.candidateId, steps, completedAt }));
    const report = { status, runId, candidateId: candidate?.candidateId, completedAt, rootDigest, steps };
    mkdirSync(runDir, { recursive: true });
    writeJsonAtomic(join(runDir, 'finalize-report.json'), report);
    let certificatePath: string | undefined;
    if (status === 'succeeded' && candidate) {
      certificatePath = join(runDir, 'success-certificate.json');
      writeJsonAtomic(certificatePath, { status: 'succeeded', runId, candidateId: candidate.candidateId, rootDigest, completedAt });
    }
    return { result: { status, steps, rootDigest, ...(certificatePath ? { certificatePath } : {}) }, report };
  };

  // 1) import evidence（真实 CLI：只收 passed 证据 + 附件哈希绑定）
  const indexFile = join(runDir, 'evidence-index.json');
  const importRun = spawnTsx(join(repoRoot, 'scripts', 'import-release-evidence.ts'), [
    '--run', runId, '--commit', candidate?.commit ?? '', '--artifact-id', candidate?.candidateId ?? '',
    '--artifact-sha256', candidate?.tgzSha256 ?? '', '--evidence-root', evidenceRoot, '--repo-root', repoRoot, '--out', indexFile,
  ]);
  if (importRun.status !== 0 || !existsSync(indexFile)) {
    push('import-evidence', 'blocked', 'RELEASE_EVIDENCE_IMPORT_FAILED');
    return finish();
  }
  push('import-evidence', 'passed');

  // 2) legacy reachability（immutable run 的 gate-report F-W3 必须 passed）
  const gateReport = readJsonSafe(join(runDir, 'gate-report.json')) as { gates?: Record<string, number> } | null;
  if (!gateReport?.gates || gateReport.gates['F-W3'] !== 0) {
    push('legacy-reachability', 'blocked', 'RELEASE_LEGACY_REACHABILITY_BLOCKED');
    return finish();
  }
  push('legacy-reachability', 'passed');

  // 3) requirement coverage（check-requirement-coverage + resolve-requirement-evidence——未全 verified 非零退出）
  const coverageRun = spawnTsx(join(repoRoot, 'scripts', 'check-requirement-coverage.ts'), []);
  const resolveRun = spawnTsx(join(repoRoot, 'scripts', 'resolve-requirement-evidence.ts'), [
    '--index', indexFile, '--run', runId, '--commit', candidate?.commit ?? '', '--artifact-id', candidate?.candidateId ?? '',
    '--artifact-sha256', candidate?.tgzSha256 ?? '', '--requirements', options.requirementsFile,
  ]);
  if (coverageRun.status !== 0 || resolveRun.status !== 0) {
    push('requirement-coverage', 'blocked', 'RELEASE_REQUIREMENT_COVERAGE_BLOCKED');
    return finish();
  }
  push('requirement-coverage', 'passed');

  // 4) 读 immutable candidate（正式校验——只读，绝不重建）
  if (!candidate || !/^[a-f0-9]{40}$/.test(candidate.commit) || !/^[a-f0-9]{64}$/.test(candidate.tgzSha256) ||
      typeof candidate.candidateId !== 'string' || typeof candidate.entrypoint !== 'string' || !candidate.cell) {
    push('read-candidate', 'blocked', candidate ? 'RELEASE_CANDIDATE_INVALID' : 'RELEASE_CANDIDATE_MISSING');
    return finish();
  }
  push('read-candidate', 'passed');

  // 5) report（步骤状态表——事实报告构建）
  push('report', 'passed');

  // 6) recompute hashes（真实 npm pack 重算 tgz sha256 vs candidate——漂移即 blocked）
  const packDest = join(runDir, 'finalize-pack');
  mkdirSync(packDest, { recursive: true });
  const packRun = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', packDest]);
  let recomputed = /sha256=([a-f0-9]{64})/.exec(packRun.stdout)?.[1] ?? '';
  if (!recomputed && packRun.status === 0) {
    try {
      const parsed = JSON.parse(packRun.stdout) as Array<{ filename: string }>;
      recomputed = sha256(readFileSync(join(packDest, parsed[0]!.filename)));
    } catch { recomputed = ''; }
  }
  if (packRun.status !== 0 || recomputed !== candidate.tgzSha256) {
    push('recompute-hashes', 'blocked', 'RELEASE_CANDIDATE_DRIFT');
    return finish();
  }
  push('recompute-hashes', 'passed');

  // 7) 比对 E/H/I digest（三者全 passed 才继续——任一 blocked 传导）
  const eAggregate = readJsonSafe(join(runDir, 'gate-e-aggregate.json'));
  if (eAggregate?.status !== 'passed') {
    push('gate-digests', 'blocked', 'RELEASE_GATE_E_BLOCKED');
    return finish();
  }
  const hOutcome = readJsonSafe(join(runDir, 'gate-h', 'outcome.json'));
  if (hOutcome?.status !== 'passed') {
    push('gate-digests', 'blocked', 'RELEASE_GATE_H_NOT_PASSED');
    return finish();
  }
  const iOutcome = readJsonSafe(join(runDir, 'gate-i', 'outcome.json'));
  // W6-05 Windows-only 范围：Gate I 不适用（跨平台验收退出必选）——不读取即不阻断；
  // all 范围行为不变（缺失/非 passed → blocked）
  if (scope === 'all' && iOutcome?.status !== 'passed') {
    push('gate-digests', 'blocked', 'RELEASE_GATE_I_NOT_PASSED');
    return finish();
  }
  push('gate-digests', 'passed');

  // 8) release gate（outcomes → check-release-eligibility）
  const outcomes = buildGateOutcomes(gateReport, eAggregate, hOutcome, iOutcome, scope);
  const outcomesFile = join(runDir, 'gate-outcomes.json');
  writeJsonAtomic(outcomesFile, outcomes);
  const eligibilityRun = spawn(process.execPath, [join(repoRoot, 'scripts', 'check-release-eligibility.mjs'), '--gates', outcomesFile, '--required', requiredReleaseGates(scope).join(',')]);
  if (eligibilityRun.status !== 0) {
    push('release-gate', 'blocked', 'RELEASE_ELIGIBILITY_FAILED');
    return finish();
  }
  push('release-gate', 'passed');

  // 9) completion gate（唯一 receipt 决定者）
  const completionRun = spawn(process.execPath, [join(repoRoot, 'scripts', 'run-completion-gate.mjs'), '--run', runId]);
  if (completionRun.status !== 0) {
    push('completion-gate', 'blocked', 'RELEASE_COMPLETION_GATE_FAILED');
    return finish();
  }
  push('completion-gate', 'passed');

  // 10) report/sign：事实报告 + （全过才写）success-certificate——绝不 publish/tag/release
  push('report-sign', 'passed');
  return finish();
}
