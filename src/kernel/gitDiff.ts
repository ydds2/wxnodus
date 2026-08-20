// src/kernel/gitDiff.ts — git 三源 diff（P3 评估轮；opencode diff-viewer.tsx:46 DiffMode "git"|"branch"|"last-turn" 对标）
// turn 源 = undoShadows 快照（sessionCommands /diff 既有路径）；本模块补 git/branch 两源。
// 安全：spawnSync 参数数组（无 shell 拼接——文件名含特殊字符无注入面）；只读 git 命令。
import { spawnSync } from 'node:child_process';

export interface GitDiffResult {
  ok: boolean;
  /** unified diff 原文（无差异时为空串） */
  diff: string;
  error?: string;
}

/** git diff 退出码语义：0=无差异 1=有差异 >1=错误（git 官方约定） */
const runGitDiff = (cwd: string, argv: string[]): GitDiffResult => {
  const r = spawnSync('git', ['--no-pager', 'diff', ...argv], { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.error) return { ok: false, diff: '', error: `git 不可用：${r.error.message}` };
  if (r.status !== null && r.status > 1) {
    const msg = String(r.stderr ?? '').trim();
    if (/not a git repository/i.test(msg)) return { ok: false, diff: '', error: '不是 git 仓库（git 源仅在有 .git 的目录可用）' };
    if (msg.includes('outside repository')) return { ok: false, diff: '', error: '文件不在 git 仓库内（git 源仅覆盖仓库内文件）' };
    return { ok: false, diff: '', error: `git diff 失败（退出码 ${r.status}）：${msg.slice(0, 200)}` };
  }
  return { ok: true, diff: String(r.stdout ?? '') };
};

/** 源① git：工作区 vs HEAD（未提交改动） */
export const gitDiffWorkingVsHead = (cwd: string, file: string): GitDiffResult =>
  runGitDiff(cwd, ['--', file]);

/** 源② branch（opencode vcs.ts:373-386 对标，2026-08-19 merge-base 语义补齐）：
 * 工作区 vs 与目标分支的 merge-base——只看本分支相对主干的整体变更
 * （不含主干自身新提交；此前 vs 分支 tip 会把主干新提交混入）。 */
export const gitDiffVsBranchMergeBase = (cwd: string, file: string, branch: string): GitDiffResult => {
  const safe = String(branch).trim();
  if (!safe || /[\s'"]/.test(safe)) return { ok: false, diff: '', error: '分支名非法（不得含空白/引号）' };
  const mb = spawnSync('git', ['--no-pager', 'merge-base', 'HEAD', safe], { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const base = String(mb.stdout ?? '').trim();
  if (mb.status !== 0 || !base) return { ok: false, diff: '', error: `与分支 ${safe} 无共同祖先（merge-base 失败）` };
  return runGitDiff(cwd, [base, '--', file]);
};

/** 默认主干探测：origin/HEAD 符号引用（无 remote 返回 null——诚实，不臆测 main/master） */
export const gitDefaultBranch = (cwd: string): string | null => {
  const r = spawnSync('git', ['--no-pager', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const v = String(r.stdout ?? '').trim();
  return r.status === 0 && v ? v : null;
};
