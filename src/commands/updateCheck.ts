// src/commands/updateCheck.ts — /update 更新检查（分发闭环 S0：诚实渠道探测 + 版本报告）
// 设计：不假装能自动更新——先如实回答「装在哪、当前什么版本、有没有远程最新版」，
//       再给出渠道对应的确切命令；git 渠道在有 remote 且工作树干净时支持 --yes 执行
//       pull+build（其余渠道只给命令，绝不代执行包管理器操作）。
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { WXNODUS_VERSION } from '../kernel/version.js';

export type InstallChannel = 'git' | 'npm-global' | 'winget' | 'scoop' | 'unknown';

export interface GitState {
  isRepo: boolean;
  remote: string | null;
  clean: boolean;
  head: string;
  date: string;
}

export interface UpdateReport {
  channel: InstallChannel;
  version: string;
  git: GitState | null;
  guidance: string;
  canAutoUpdate: boolean;
}

/** 纯函数：从模块路径推断安装渠道（可单测）。npm link 指向仓库目录 → git；npm -g → npm-global。 */
export function detectInstallChannel(modulePath: string): InstallChannel {
  const norm = modulePath.replace(/\\/g, '/');
  if (norm.includes('/node_modules/')) {
    // npm 全局安装：<prefix>/node_modules/wxnodus/…（npm link 例外——link 目标是仓库目录，不含 node_modules 中间段）
    return 'npm-global';
  }
  // 其余（仓库内 dist/ 或 tsx src/）按 git 工作树处理；是否真 git 由 probeGit 判定
  return 'git';
}

/** 仓库根定位（纯函数）：沿模块路径向上找 package.json 且 name=wxnodus 的目录。 */
export function findRepoRoot(modulePath: string, readFile: (p: string) => string | null = p => { try { return require('node:fs').readFileSync(p, 'utf8'); } catch { return null; } }): string | null {
  let dir = dirname(modulePath);
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (readFile(pkg)) {
      try { if (JSON.parse(readFile(pkg)!).name === 'wxnodus') return dir; } catch { /* 继续上探 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** git 探测（真实执行；任何失败返回 isRepo=false 的降级态——绝不抛出）。 */
export function probeGit(cwd: string): GitState {
  const none: GitState = { isRepo: false, remote: null, clean: true, head: '', date: '' };
  const run = (args: string): string | null => {
    try { return execSync(`git ${args}`, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  };
  const head = run('rev-parse --short HEAD');
  if (head === null) return none;
  const remote = run('remote get-url origin');
  const status = run('status --porcelain');
  const date = run('log -1 --format=%cd --date=short');
  return { isRepo: true, remote: remote || null, clean: status === '', head, date: date ?? '' };
}

/** 渠道命令（人话指引，纯函数可单测）。 */
export function channelGuidance(channel: InstallChannel, git: GitState | null): string {
  switch (channel) {
    case 'npm-global':
      return 'npm install -g wxnodus@latest（需已发布到 npm registry——未发布时此命令报 404，属预期）';
    case 'winget':
      return 'winget upgrade <PackageId>（manifest 需已发布到 winget-pkgs 仓库）';
    case 'scoop':
      return 'scoop update wxnodus（bucket 需已收录）';
    case 'git': {
      if (!git?.isRepo) return '当前运行产物不在 git 工作树内——无法判定更新来源（请说明安装方式）';
      if (!git.remote) return `本仓库未配置 git remote（origin 缺失）——无远程最新版可拉；当前 HEAD ${git.head} @ ${git.date}。配置 remote 后可用 /update --yes 拉取重建`;
      if (!git.clean) return `工作树有未提交改动（git status 非空）——先提交/暂存后再更新（/update --yes 拒绝对脏树执行）`;
      return `git pull && npm install && npm run build（远程 ${git.remote}）`;
    }
    default:
      return '无法确定安装渠道——请手动执行对应包管理器更新';
  }
}

/** 汇总报告（handler 入口）。 */
export function buildUpdateReport(opts: { modulePath: string; cwd: string }): UpdateReport {
  const channel = detectInstallChannel(opts.modulePath);
  const repoRoot = channel === 'git' ? (findRepoRoot(opts.modulePath) ?? opts.cwd) : null;
  const git = repoRoot ? probeGit(repoRoot) : null;
  const guidance = channelGuidance(channel, git);
  const canAutoUpdate = channel === 'git' && git?.isRepo === true && Boolean(git.remote) && git.clean;
  return { channel, version: WXNODUS_VERSION, git, guidance, canAutoUpdate };
}

/** 渠道中文名（显示用）。 */
export function channelLabel(channel: InstallChannel): string {
  return { git: 'git 工作树/npm link', 'npm-global': 'npm 全局安装', winget: 'winget', scoop: 'scoop', unknown: '未知' }[channel];
}
