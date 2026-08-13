// src/infrastructure/autonomy/worktreeManager.ts — W2-10：子代理 worktree 管理（git executable+argv、shell:false）
// 路径先 lexical + realpath 双重校验（drive/UNC/junction 越界 → WORKTREE_PATH_ESCAPE）；ownedFiles 在 effect normalization 后、PDP 前逐一校验
import type { OperationResult } from '../../protocol/results.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface WorktreeManagerPorts {
  dataDir: string;
  /** W1 ProcessSupervisor 注入：executable + argv（git），shell:false */
  git(args: string[], options?: { cwd?: string }): Promise<OperationResult<{ stdout: string; stderr: string }>>;
  realpath(path: string): Promise<string>;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** lexical 包含性检查（规范化后必须落在 base 内） */
const within = (base: string, target: string): boolean => {
  const normalized = target.replace(/\\/g, '/');
  const root = base.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized === root || normalized.startsWith(`${root}/`);
};

export class WorktreeManager {
  constructor(private readonly ports: WorktreeManagerPorts) {}

  worktreePath(taskId: string): string {
    return `${this.ports.dataDir.replace(/\\/g, '/').replace(/\/$/, '')}/worktrees/${taskId}`;
  }

  async assertTaskIdSafe(taskId: string, path: string): Promise<OperationResult<void>> {
    if (!SAFE_TASK_ID.test(taskId)) return fail('WORKTREE_PATH_ESCAPE', { taskId });
    const base = `${this.ports.dataDir.replace(/\\/g, '/').replace(/\/$/, '')}/worktrees`;
    if (!within(base, path)) return fail('WORKTREE_PATH_ESCAPE', { path, base });
    try {
      const real = (await this.ports.realpath(path)).replace(/\\/g, '/');
      if (!within(base, real)) return fail('WORKTREE_PATH_ESCAPE', { path, real, base });
    } catch {
      // 尚未存在（add 前）——lexical 校验已通过
    }
    return { ok: true, value: undefined };
  }

  async add(taskId: string, baseCommit: string): Promise<OperationResult<{ path: string }>> {
    const path = this.worktreePath(taskId);
    const safe = await this.assertTaskIdSafe(taskId, path);
    if (!safe.ok) return safe;
    const result = await this.ports.git(['worktree', 'add', '--detach', path, baseCommit]);
    return result.ok ? { ok: true, value: { path } } : fail('WORKTREE_ADD_FAILED', { stderr: result.error.message });
  }

  async remove(taskId: string): Promise<OperationResult<void>> {
    const path = this.worktreePath(taskId);
    const safe = await this.assertTaskIdSafe(taskId, path);
    if (!safe.ok) return safe;
    const result = await this.ports.git(['worktree', 'remove', '--force', path]);
    return result.ok ? { ok: true, value: undefined } : fail('WORKTREE_REMOVE_FAILED', { stderr: result.error.message });
  }

  /** ownedFiles 逐文件校验：effect 触碰的每个文件必须落在 owned 集合内（越界 → OWNED_FILE_SCOPE_DENIED） */
  assertOwnedFiles(ownedFiles: readonly string[], effectFiles: readonly string[]): OperationResult<void> {
    const owned = new Set(ownedFiles.map(file => file.replace(/\\/g, '/')));
    const escaped = effectFiles.map(file => file.replace(/\\/g, '/')).filter(file =>
      ![...owned].some(scope => file === scope || file.startsWith(`${scope.replace(/\/$/, '')}/`)));
    return escaped.length === 0 ? { ok: true, value: undefined } : fail('OWNED_FILE_SCOPE_DENIED', { escaped: escaped.slice(0, 10) });
  }
}
