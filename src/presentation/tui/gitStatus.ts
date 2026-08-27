// src/presentation/tui/gitStatus.ts — 只读 git 分支探测（kimi code 风格化，2026-08-28）
// 机制参考：kimi-cli ui/shell/prompt.py:_get_git_branch（底栏显示当前 git 分支徽标）——
// 实现原创：不 spawn git 子进程，纯读 .git 文件（HEAD → refs/heads/x → packed-refs 回退），
// 零网络零执行；非 git 工作区诚实返回 null。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 读工作区 git 分支名（detached 返回短哈希；非 git 工作区/不可读返回 null） */
export function gitBranch(cwd: string): string | null {
  try {
    const headPath = join(cwd, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf8').trim();
    const refMatch = /^ref:\s+refs\/heads\/(.+)$/.exec(head);
    if (refMatch) {
      const branch = refMatch[1];
      const loosePath = join(cwd, '.git', 'refs', 'heads', ...branch.split('/'));
      if (existsSync(loosePath)) return branch;
      // 打包 ref 回退（packed-refs）；ref 文件均缺失时仍返回分支名（诚实降级）
      const packed = join(cwd, '.git', 'packed-refs');
      if (existsSync(packed)) {
        const content = readFileSync(packed, 'utf8');
        const line = content.split(/\r?\n/).find(l => l.trim().endsWith(`refs/heads/${branch}`));
        if (line) return branch;
      }
      return branch;
    }
    // detached HEAD：取短哈希
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}
