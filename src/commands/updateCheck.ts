// src/commands/updateCheck.ts — /update 更新检查（分发闭环 S0：诚实渠道探测 + 版本报告）
// 设计：不假装能自动更新——先如实回答「装在哪、当前什么版本、有没有远程最新版」，
//       再给出渠道对应的确切命令；git 渠道在有 remote 且工作树干净时支持 --yes 执行
//       pull+build（其余渠道只给命令，绝不代执行包管理器操作）。
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { WXNODUS_VERSION } from '../kernel/version.js';

export type InstallChannel = 'git' | 'npm-global' | 'winget' | 'scoop' | 'zip' | 'unknown';

export interface GitState {
  isRepo: boolean;
  remote: string | null;
  clean: boolean;
  head: string;
  date: string;
}

/** zip 渠道元数据（install.ps1 安装时写入 install-meta.json；source 由 -Source 透传，供远程版本探测）。 */
export interface InstallMeta {
  app: string;
  version: string;
  installedAt?: string;
  source?: string;
}

export interface UpdateReport {
  channel: InstallChannel;
  version: string;
  git: GitState | null;
  installMeta: InstallMeta | null;
  guidance: string;
  canAutoUpdate: boolean;
}

/** zip 渠道元数据上探（≤5 层找 install-meta.json）；BOM 容忍 + 损坏/缺字段返回 null（绝不抛出）。 */
export function findInstallMeta(modulePath: string, readFile: (p: string) => string | null = p => { try { return require('node:fs').readFileSync(p, 'utf8'); } catch { return null; } }): InstallMeta | null {
  let dir = dirname(modulePath);
  for (let i = 0; i < 5; i++) {
    const text = readFile(join(dir, 'install-meta.json'));
    if (text !== null) {
      try {
        const meta = JSON.parse(text.replace(/^\uFEFF/, '')) as InstallMeta;
        if (meta && typeof meta.app === 'string' && typeof meta.version === 'string') return meta;
      } catch { return null; }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 纯函数：从模块路径推断安装渠道（可单测）。zip（install-meta 命中）优先于 git/npm。 */
export function detectInstallChannel(modulePath: string): InstallChannel {
  if (findInstallMeta(modulePath)) return 'zip';
  const norm = modulePath.replace(/\\/g, '/');
  if (norm.includes('/node_modules/')) {
    // npm 全局安装：<prefix>/node_modules/wxnodus/…（npm link 例外——link 目标是仓库目录，不含 node_modules 中间段）
    return 'npm-global';
  }
  // 其余（仓库内 dist/ 或 tsx src/）按 git 工作树处理；是否真 git 由 probeGit 判定
  return 'git';
}

/** 远程版本探测（zip + -Source 记录）：仅 https；HEAD 4s 超时；版本号从 Content-Disposition 文件名/最终 URL 提取。 */
export async function probeRemoteVersion(source: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; version?: string; message: string }> {
  if (!/^https:\/\//.test(source)) return { ok: false, message: `更新源非 https，拒绝探测：${source}` };
  try {
    const res = await fetchImpl(source, { method: 'HEAD', signal: AbortSignal.timeout(4000), redirect: 'follow' });
    if (!res.ok && res.status !== 200) return { ok: false, message: `更新源响应 ${res.status}` };
    const disposition = res.headers.get('content-disposition') ?? '';
    const url = res.url ?? source;
    const m = /(\d+\.\d+\.\d+)/.exec(`${disposition} ${url}`);
    if (!m) return { ok: false, message: '响应中未解析出版本号（Content-Disposition/URL 均无）' };
    return { ok: true, version: m[1]!, message: '' };
  } catch (e: any) {
    return { ok: false, message: `探测失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
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
    case 'zip':
      return '离线 zip 安装渠道：下载新版 wxnodus-<版本>.zip → 解压 → 双击 install.bat（或 powershell -ExecutionPolicy Bypass -File install.ps1）幂等覆盖安装；数据目录与密钥保留（安装不删 %LOCALAPPDATA%\\wxnodus）。';
    default:
      return '无法确定安装渠道——请手动执行对应包管理器更新';
  }
}

/** 汇总报告（handler 入口）。 */
export function buildUpdateReport(opts: { modulePath: string; cwd: string }): UpdateReport {
  const channel = detectInstallChannel(opts.modulePath);
  const installMeta = channel === 'zip' ? findInstallMeta(opts.modulePath) : null;
  const repoRoot = channel === 'git' ? (findRepoRoot(opts.modulePath) ?? opts.cwd) : null;
  const git = repoRoot ? probeGit(repoRoot) : null;
  const guidance = channelGuidance(channel, git);
  const canAutoUpdate = channel === 'git' && git?.isRepo === true && Boolean(git.remote) && git.clean;
  return { channel, version: WXNODUS_VERSION, git, installMeta, guidance, canAutoUpdate };
}

/** 渠道中文名（显示用）。 */
export function channelLabel(channel: InstallChannel): string {
  return { git: 'git 工作树/npm link', 'npm-global': 'npm 全局安装', winget: 'winget', scoop: 'scoop', zip: '离线 zip 安装', unknown: '未知' }[channel];
}

/** 出站连通探测（首启代理指引用）：默认 2.5s 超时；HTTP <500 视为可达；异常诚实 message。 */
export async function probeOutbound(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2500): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok || res.status < 500, message: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e).slice(0, 120) };
  }
}

/** 首启四步清单（纯函数可单测）：模型/密钥/代理（按探测结果分支）/离线收尾。 */
export type FirstRunChecklistKey = 'onboarding.checklist.model' | 'onboarding.checklist.key' | 'onboarding.checklist.proxy.ok' | 'onboarding.checklist.proxy.fail' | 'onboarding.checklist.offline';
export function firstRunChecklistLines<L extends string>(locale: L, net: { ok: boolean; message: string }, t: (locale: L, key: FirstRunChecklistKey) => string): string[] {
  return [
    t(locale, 'onboarding.checklist.model'),
    t(locale, 'onboarding.checklist.key'),
    net.ok ? t(locale, 'onboarding.checklist.proxy.ok') : t(locale, 'onboarding.checklist.proxy.fail'),
    t(locale, 'onboarding.checklist.offline'),
  ];
}
