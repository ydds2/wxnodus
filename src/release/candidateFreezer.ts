// src/release/candidateFreezer.ts — W6-04：发布候选冻结器（pack:release 唯一 candidate builder——绝不发布）
// 真实 npm pack（prepack 构建链）→ tgz 落 run 目录 + sha256 计算 → candidate.json 元数据
// （candidateId/commit/tgzSha256/cell/entrypoint/dynamicImportDeclarations）→ 读回自校验。
// 消费方：package-installer.ts（重收 dist + 闭包）、Gate H、release:finalize（漂移检测）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { WXNODUS_VERSION } from '../kernel/version.js';
import type { OperationResult } from '../protocol/results.js';
import { configError } from '../domain/config/configSchema.js';
import { runBuildChain } from './buildChain.js';

export interface FreezeCandidateOptions {
  repoRoot: string;
  runId: string;
  outDir: string;
  /** 注入构建链（测试用）；缺省真实 npm run build（W8-18：npm pack 不触发 prepack，绝不冻结陈旧 dist） */
  build?: (repoRoot: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 注入 pack（测试用）；缺省真实 npm pack（prepack 构建链） */
  pack?: (packDestination: string) => Promise<{ ok: true; tgzFile: string } | { ok: false; error: string }>;
  now?: () => string;
}

export interface FreezeCandidateResult {
  candidateFile: string;
  sbomFile: string;
  tgzFile: string;
  candidateId: string;
  commit: string;
  tgzSha256: string;
  sbomSha256: string;
  cell: { os: string; arch: string; node: string };
  distTreeSha256: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function hashDistTree(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const rel = relative(root, path).replace(/\\/g, '/');
        hash.update(rel).update('\0').update(readFileSync(path)).update('\n');
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

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
  // W8-18：pack 前显式构建（npm pack 在本仓库不触发 prepack——绝不冻结陈旧 dist）
  const build = await (options.build ?? (async (root: string) => runBuildChain(root)))(repoRoot);
  if (!build.ok) {
    return { ok: false, error: configError('FREEZE_BUILD_FAILED', 'freeze.build.failed', { cause: build.error.slice(0, 300) }) };
  }
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const packed = await (options.pack ?? (() => realPack(repoRoot, outDir)))(outDir);
  if (!packed.ok) {
    return { ok: false, error: configError('FREEZE_PACK_FAILED', 'freeze.pack.failed', { cause: packed.error.slice(0, 300) }) };
  }
  const tgzBytes = readFileSync(packed.tgzFile);
  const tgzSha256 = sha256(tgzBytes);
  const distTreeDigest = hashDistTree(join(repoRoot, 'dist'));
  const now = options.now ?? (() => new Date().toISOString());
  const candidateId = `cand-${commit.slice(0, 10)}-${now().replace(/[-:T]/g, '').slice(0, 12)}`;
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string; integrity?: string; license?: string; dependencies?: Record<string, string> }> };
  const components = Object.entries(lock.packages ?? {})
    .filter(([path]) => path.startsWith('node_modules/'))
    .map(([path, item]) => ({
      bomRef: path.slice('node_modules/'.length),
      name: path.slice('node_modules/'.length),
      version: item.version ?? 'unknown',
      integrity: item.integrity ?? null,
      license: item.license ?? null,
      dependencies: Object.keys(item.dependencies ?? {}),
    }))
    .sort((left, right) => left.bomRef.localeCompare(right.bomRef));
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { component: { name: 'wxnodus', version: WXNODUS_VERSION } },
    components,
  };
  const sbomFile = join(outDir, 'sbom.json');
  const sbomBody = `${JSON.stringify(sbom, null, 2)}\n`;
  writeFileSync(sbomFile, sbomBody, 'utf8');
  const sbomSha256 = sha256(Buffer.from(sbomBody));
  const candidate = {
    candidateId,
    commit,
    tgzSha256,
    sbomSha256,
    distTreeSha256: distTreeDigest,
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
      sbomFile: resolve(sbomFile),
      tgzFile: resolve(packed.tgzFile),
      candidateId,
      commit,
      tgzSha256,
      sbomSha256,
      cell: candidate.cell,
      distTreeSha256: distTreeDigest,
    },
  };
}
