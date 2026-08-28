// src/kernel/gitPublish.ts — 目录→Git 仓库发布流（数据主权修订 · 2026-08-28）
// 用户裁决（2026-08-28）：数据可出机——上传 git / 用户自行发布 GitHub 等开源平台 / 自迭代。
// 定位从「数据不出机」修订为「数据主权本机」：默认全本地；出机必须是用户显式动作
// （本模块的 remote 一律来自用户命令行输入），wxnodus 绝不自动推送。
// 安全口径：
//   · remote 校验：http(s):// 与 ssh/git@ 恒可；file:// 或本地路径属内网/本机 Git 服务，
//     须显式 localRemote:true 才放行（防配置注入把代码推到意外本地位置）；
//   · 身份零污染：commit 经 `-c user.name/-c user.email` 每命令注入，绝不改全局/仓库 git 配置；
//   · execFile 参数数组直传（零 shell 拼接）；push 超时 180s（网络操作）；
//   · 竞品参考：kimi share.py / opencode share 均为云 token/链接（中心服务器）——本仓按新裁决
//     走「用户自有 Git remote」形态，无 wxnodus 侧服务（差异如实记录）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 默认 git 执行器（spawn git；ENOENT → code:-1 诚实报「未安装/不在 PATH」） */
export const defaultGitRunner: GitRunner = async (args, opts = {}) => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (err.code === 'ENOENT') return { code: -1, stdout: '', stderr: '未找到 git（请安装 Git 并确保在 PATH）' };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? '').slice(0, 400),
    };
  }
};

export interface PublishToGitOptions {
  /** 用户提供的 Git remote（https://… / git@… / ssh://…；本地路径与 file:// 须 localRemote:true） */
  remote: string;
  /** 目标分支（缺省 main；仓库非空且分支已存在则直接推） */
  branch?: string;
  /** 提交信息（缺省自动生成） */
  message?: string;
  /** 允许本地路径/file:// remote（内网/本机 Git 服务与测试场景——显式声明） */
  localRemote?: boolean;
  /** 提交身份（缺省 wxnodus-publish，仅本次提交有效） */
  identity?: { name: string; email: string };
  /** 测试注入 */
  runner?: GitRunner;
}

export type PublishToGitResult =
  | { ok: true; initialized: boolean; committed: boolean; pushed: boolean; branch: string; commit?: string; remote: string }
  | { ok: false; error: string };

/** remote 形态校验（纯函数）：http(s)/ssh 恒可；其余（file://、路径、其他 scheme）需 localRemote */
export function remoteAllowed(remote: string, localRemote: boolean): boolean {
  const r = remote.trim();
  if (!r) return false;
  if (/^https?:\/\//i.test(r) || /^git@/i.test(r) || /^ssh:\/\//i.test(r)) return true;
  return localRemote === true;
}

/**
 * 把目录发布为 Git 仓库（初始化-if-needed → origin 绑定 → add+commit → push -u）。
 * 幂等语义：已是仓库则增量提交；无变更 committed=false 仍尝试推送；push 失败诚实回 stderr
 * （鉴权失败提示 SSH key / PAT——绝不吞错假装成功）。
 */
export async function publishDirToGit(dir: string, opts: PublishToGitOptions): Promise<PublishToGitResult> {
  const run = opts.runner ?? defaultGitRunner;
  const branch = (opts.branch ?? 'main').trim() || 'main';
  const remote = opts.remote.trim();
  if (!remoteAllowed(remote, opts.localRemote === true)) {
    return { ok: false, error: `remote 形态不受支持（${remote.slice(0, 80)}）——允许 https:// git@ ssh://；本地路径/file:// 须显式 --local-remote（内网/本机 Git 服务）` };
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, error: `发布目录不存在：${dir}` };
  }
  const at = (args: string[], timeoutMs?: number) => run(args, { cwd: dir, timeoutMs });

  // ① 仓库判定/初始化（git ≥2.28 init -b；老版本回退 init + checkout -B）
  let initialized = false;
  const inside = await at(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    let r = await at(['init', '-b', branch]);
    if (r.code !== 0) {
      r = await at(['init']);
      if (r.code !== 0) return { ok: false, error: `git init 失败：${r.stderr || r.stdout}` };
      const cb = await at(['checkout', '-B', branch]);
      if (cb.code !== 0) return { ok: false, error: `分支切换失败（${branch}）：${cb.stderr}` };
    }
    initialized = true;
  }

  // ② origin 绑定（无则加；有且不同则 set-url——用户的 remote 永远是事实源）
  const cur = await at(['remote', 'get-url', 'origin']);
  if (cur.code !== 0) {
    const r = await at(['remote', 'add', 'origin', remote]);
    if (r.code !== 0) return { ok: false, error: `remote add 失败：${r.stderr}` };
  } else if (cur.stdout.trim() !== remote) {
    const r = await at(['remote', 'set-url', 'origin', remote]);
    if (r.code !== 0) return { ok: false, error: `remote set-url 失败：${r.stderr}` };
  }

  // ③ 提交（身份每命令注入——零配置污染）
  const idName = opts.identity?.name ?? 'wxnodus-publish';
  const idEmail = opts.identity?.email ?? 'wxnodus-publish@users.noreply.local';
  const cfg = ['-c', `user.name=${idName}`, '-c', `user.email=${idEmail}`];
  const add = await at(['add', '-A']);
  if (add.code !== 0) return { ok: false, error: `git add 失败：${add.stderr}` };
  const status = await at(['status', '--porcelain']);
  if (status.code !== 0) return { ok: false, error: `git status 失败：${status.stderr}` };
  let committed = false;
  let commit = '';
  if (status.stdout.trim().length > 0) {
    const msg = opts.message?.trim() || `wxnodus bundle publish (${new Date().toISOString()})`;
    const c = await at([...cfg, 'commit', '-m', msg]);
    if (c.code !== 0) return { ok: false, error: `git commit 失败：${c.stderr}` };
    committed = true;
    const rev = await at(['rev-parse', '--short', 'HEAD']);
    commit = rev.stdout.trim();
  }

  // ④ 推送（网络 180s；失败诚实回显——鉴权/权限类错误直达用户）
  const push = await at(['push', '-u', 'origin', branch], 180_000);
  if (push.code !== 0) {
    return {
      ok: false,
      error: `推送失败（origin/${branch}）：${push.stderr || push.stdout || '未知错误'}${/auth|denied|permission|403/i.test(push.stderr) ? '——请检查 SSH 私钥或 Personal Access Token 权限' : ''}`,
    };
  }
  return { ok: true, initialized, committed, pushed: true, branch, ...(commit ? { commit } : {}), remote };
}
