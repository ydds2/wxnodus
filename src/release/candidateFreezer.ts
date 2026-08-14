// src/release/candidateFreezer.ts — W6-04：发布候选冻结器（pack:release 唯一 candidate builder——绝不发布）
// 真实 npm pack（prepack 构建链）→ tgz 落 run 目录 + sha256 计算 → candidate.json 元数据
// （candidateId/commit/tgzSha256/cell/entrypoint/dynamicImportDeclarations）→ 读回自校验。
// 消费方：package-installer.ts（重收 dist + 闭包）、Gate H、release:finalize（漂移检测）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { OperationResult } from '../protocol/results.js';
import { configError } from '../domain/config/configSchema.js';

export interface FreezeCandidateOptions {
  repoRoot: string;
  runId: string;
  outDir: string;
  /** 注入 pack（测试用）；缺省真实 npm pack（prepack 构建链） */
  pack?: (packDestination: string) => Promise<{ ok: true; tgzFile: string } | { ok: false; error: string }>;
  now?: () => string;
}

export interface FreezeCandidateResult {
  candidateFile: string;
  tgzFile: string;
  candidateId: string;
  commit: string;
  tgzSha256: string;
  cell: { os: string; arch: string; node: string };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const realPack = async (repoRoot: string, packDestination: string): Promise<{ ok: true; tgzFile: string } | { ok: false; error: string }> => {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const output = execFileSync(npm, ['pack', '--json', '--pack-destination', packDestination], {
      cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32',
      timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(output) as Array<{ filename: string }>;
    return { ok: true, tgzFile: join(packDestination, parsed[0]!.filename) };
  } catch (cause) {
    return { ok: false, error: String((cause as { stderr?: unknown; message?: string })?.stderr ?? (cause as Error)?.message ?? cause) };
  }
};

export async function freezeCandidate(options: FreezeCandidateOptions): Promise<OperationResult<FreezeCandidateResult>> {
  const { repoRoot, outDir } = options;
  void options.runId;
  // 入口必须在冻结前存在（绝不冻结不存在的运行时树）
  if (!existsSync(join(repoRoot, 'dist', 'cli', 'index.js'))) {
    return { ok: false, error: configError('FREEZE_DIST_MISSING', 'freeze.dist.missing', { repoRoot }) };
  }
  let commit: string;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', shell: false }).trim();
  } catch {
    return { ok: false, error: configError('FREEZE_COMMIT_MISSING', 'freeze.commit.missing') };
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    return { ok: false, error: configError('FREEZE_COMMIT_INVALID', 'freeze.commit.invalid', { commit }) };
  }
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const packed = await (options.pack ?? (() => realPack(repoRoot, outDir)))(outDir);
  if (!packed.ok) {
    return { ok: false, error: configError('FREEZE_PACK_FAILED', 'freeze.pack.failed', { cause: packed.error.slice(0, 300) }) };
  }
  const tgzBytes = readFileSync(packed.tgzFile);
  const tgzSha256 = sha256(tgzBytes);
  const now = options.now ?? (() => new Date().toISOString());
  const candidateId = `cand-${commit.slice(0, 10)}-${now().replace(/[-:T]/g, '').slice(0, 12)}`;
  const candidate = {
    candidateId,
    commit,
    tgzSha256,
    cell: { os: process.platform, arch: process.arch, node: process.version },
    entrypoint: 'dist/cli/index.js',
    dynamicImportDeclarations: [] as string[],
    frozenAt: now(),
  };
  const candidateFile = join(outDir, 'candidate.json');
  const body = `${JSON.stringify(candidate, null, 2)}\n`;
  const tmp = `${candidateFile}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, candidateFile);
  rmSync(tmp, { force: true });
  // 读回自校验（冻结器绝不自欺）
  if (readFileSync(candidateFile, 'utf8') !== body) {
    return { ok: false, error: configError('FREEZE_READBACK_FAILED', 'freeze.readback.failed') };
  }
  return {
    ok: true,
    value: {
      candidateFile: resolve(candidateFile),
      tgzFile: resolve(packed.tgzFile),
      candidateId,
      commit,
      tgzSha256,
      cell: candidate.cell,
    },
  };
}
