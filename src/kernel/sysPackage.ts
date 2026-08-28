// src/kernel/sysPackage.ts — Windows 包管理器自适应（自装依赖/软件 · 2026-08-28）
// 目标（用户裁决：完全操作 Windows 系统 + 自行下载依赖/软件）：agent 经审批门安装软件。
// 自适应链：winget → scoop → choco（PATH 探测，进程内缓存）；探测不到 → 诚实报装法。
// 安全口径：danger 工具（tools.ts 注册 danger:true → 审批链）；命令经 execFile 参数数组直传；
// install 长超时 600s（settings.sysPkgTimeoutMs 可调）；-e 精确 ID + 协议自动接受仅限 winget 官方语义。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export type PkgManager = 'winget' | 'scoop' | 'choco';

export type SysRunner = (bin: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultSysRunner: SysRunner = async (bin, args, opts = {}) => {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (err.code === 'ENOENT') return { code: -1, stdout: '', stderr: `未找到 ${bin}（不在 PATH）` };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '').slice(0, 400) };
  }
};

const CANDIDATES: PkgManager[] = ['winget', 'scoop', 'choco'];
let cached: PkgManager | null | undefined;

/** 测试口：清探测缓存（生产不调用） */
export function resetPkgManagerCacheForTests(): void { cached = undefined; }

/** 探测可用包管理器（winget>scoop>choco；显式指定但不可用 → 诚实报错；缓存进程内一次） */
export async function detectPackageManager(explicit?: string, runner: SysRunner = defaultSysRunner): Promise<PkgManager | null> {
  if (explicit) {
    const e = explicit as PkgManager;
    if (!CANDIDATES.includes(e)) throw new Error(`不支持的 manager：${explicit}（支持 ${CANDIDATES.join('/')}）`);
    const r = await runner(e, ['--version'], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`${e} 不可用（${r.stderr || '探测失败'}）——请先安装或改用 --manager 指定其他管理器`);
    return e;
  }
  if (cached !== undefined) return cached;
  for (const m of CANDIDATES) {
    const r = await runner(m, ['--version'], { timeoutMs: 15_000 });
    if (r.code === 0) { cached = m; return m; }
  }
  cached = null;
  return null;
}

const INSTALL_TIMEOUT_MS_DEFAULT = 600_000;

/** install 参数构造（纯函数）：-e 精确匹配 + 协议自动接受（winget）/ -y（choco）——各家官方非交互语义 */
export function buildInstallArgs(manager: PkgManager, id: string): string[] {
  switch (manager) {
    case 'winget': return ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'];
    case 'scoop': return ['install', id];
    case 'choco': return ['install', id, '-y', '--no-progress'];
  }
}

export function buildSearchArgs(manager: PkgManager, query: string): string[] {
  switch (manager) {
    case 'winget': return ['search', query, '--accept-source-agreements'];
    case 'scoop': return ['search', query];
    case 'choco': return ['search', query, '--limit-output', '--exact', 'false'];
  }
}

export interface SysPkgResult { ok: boolean; manager: PkgManager; output: string }

/** 搜索（只读语义——但保持统一经工具审批面：本工具整体 danger） */
export async function searchPackages(query: string, opts: { manager?: string; runner?: SysRunner } = {}): Promise<SysPkgResult> {
  const manager = await detectPackageManager(opts.manager, opts.runner);
  if (!manager) throw new Error('未找到任何包管理器（winget/scoop/choco 均不在 PATH）——请先安装其一');
  const r = await (opts.runner ?? defaultSysRunner)(manager, buildSearchArgs(manager, query));
  return { ok: r.code === 0, manager, output: (r.code === 0 ? r.stdout : `搜索失败（${manager}）：${r.stderr || r.stdout}`).slice(0, 6000) };
}

/** 安装（经 tools 层审批门后执行；超时默认 600s，settings.sysPkgTimeoutMs） */
export async function installPackage(id: string, opts: { manager?: string; runner?: SysRunner; timeoutMs?: number } = {}): Promise<SysPkgResult> {
  const manager = await detectPackageManager(opts.manager, opts.runner);
  if (!manager) throw new Error('未找到任何包管理器（winget/scoop/choco 均不在 PATH）——请先安装其一');
  const r = await (opts.runner ?? defaultSysRunner)(manager, buildInstallArgs(manager, id), { timeoutMs: opts.timeoutMs ?? INSTALL_TIMEOUT_MS_DEFAULT });
  const tail = (r.code === 0 ? r.stdout : `安装失败（${manager} 退出码 ${r.code}）：${r.stderr || r.stdout}`).slice(0, 6000);
  return { ok: r.code === 0, manager, output: tail };
}
