// packages/vscode-ext/src/gitDiff.ts — P2-12（2026-08-27）：工作区改动收集（diff 视图数据源）
// 零 vscode 依赖（node:test 可测）：回合终态后收集工作区 git 改动（HEAD 相对）——
// 代理只显示「本轮 agent 改了什么」，不自动 commit（用户裁决权）。诚实降级：
// 无 git/非仓库/超限 → unavailable（理由），绝不假装有 diff。
import { execFile } from 'node:child_process';

export interface WorkspaceDiff {
  files: Array<{ file: string; diff: string }>;
  totalBytes: number;
}

export interface DiffUnavailable {
  unavailable: string;
}

const PER_FILE_CAP = 40 * 1024;
const TOTAL_CAP = 200 * 1024;

const execText = (cmd: string, args: string[], cwd: string, timeoutMs = 15_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) { reject(error); return; }
        resolve(stdout);
      });
  });

/** 收集工作区相对 HEAD 的 diff（每文件截断标注——诚实，绝不静默砍断） */
export async function collectWorkspaceDiff(cwd: string, cap = { perFile: PER_FILE_CAP, total: TOTAL_CAP }): Promise<WorkspaceDiff | DiffUnavailable> {
  let diffText: string;
  try {
    diffText = await execText('git', ['diff', 'HEAD', '--', '.'], cwd);
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (/ENOENT/i.test(msg)) return { unavailable: '未找到 git（PATH 或安装缺失）——diff 视图不可用' };
    return { unavailable: '非 git 仓库或无改动（git diff HEAD 失败）——diff 视图不可用' };
  }
  if (!diffText.trim()) return { unavailable: '本轮无文件改动' };
  // 按 diff 文件头拆分（^diff --git a/... b/...）
  const chunks = diffText.split(/^(?=diff --git )/m).filter(s => s.trim());
  const files: Array<{ file: string; diff: string }> = [];
  let total = 0;
  for (const chunk of chunks) {
    const head = chunk.split('\n', 1)[0] ?? '';
    const m = /^diff --git a\/(.+?) b\//.exec(head);
    const file = m?.[1] ?? '(未知文件)';
    if (total >= cap.total) { files.push({ file, diff: `…[总 diff 超过 ${cap.total / 1024}KB 上限，已截断——终端 git diff 查看全部]` }); break; }
    const cut = chunk.length > cap.perFile ? chunk.slice(0, cap.perFile) + `\n…[该文件 diff 超过 ${cap.perFile / 1024}KB 已截断——终端 git diff -- ${file} 查看全部]` : chunk;
    files.push({ file, diff: cut });
    total += cut.length;
  }
  return { files, totalBytes: total };
}
