// src/application/autonomy/subagentService.ts — W2-10：子代理启动服务（worktree + lineage 预算收窄 + 作用域只缩不扩）
// child 的 depth/fanout/concurrent-agent/全部预算 limits 取 parent 剩余额的逐维 min；grant/tool/file/secret scope 只能收窄
import type { OperationResult } from '../../protocol/results.js';
import type { BudgetDimension } from '../../domain/autonomy/budgetDimensions.js';
import type { SubagentHost, SubagentStartReceipt, SubagentStopReceipt } from '../../infrastructure/autonomy/subagentHost.js';
import type { WorktreeManager } from '../../infrastructure/autonomy/worktreeManager.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface SubagentBudgetRequest {
  parentRemaining: Record<BudgetDimension, number>;
  requested: Partial<Record<BudgetDimension, number>>;
}

/** 逐维 min：child 任何维度不得大于 parent 剩余额 */
export function narrowBudgets(parentRemaining: Record<BudgetDimension, number>, requested: Partial<Record<BudgetDimension, number>>): Record<BudgetDimension, number> {
  const narrowed = { ...parentRemaining };
  for (const [key, value] of Object.entries(requested)) {
    const dimension = key as BudgetDimension;
    if (value !== undefined) narrowed[dimension] = Math.min(parentRemaining[dimension], value);
  }
  return narrowed;
}

export interface SubagentScope {
  toolIds: string[];
  filePaths: string[];
  secretIds: string[];
}

/** scope 只能收窄：child scope 必须是 parent scope 的子集 */
export function narrowScope(parent: SubagentScope, requested: Partial<SubagentScope>): SubagentScope {
  const inParent = (values: string[] | undefined, allowed: string[]) =>
    (values ?? allowed).filter(value => allowed.includes(value));
  return {
    toolIds: inParent(requested.toolIds, parent.toolIds),
    filePaths: inParent(requested.filePaths, parent.filePaths),
    secretIds: inParent(requested.secretIds, parent.secretIds),
  };
}

export interface SubagentStartRequest {
  taskId: string;
  baseCommit: string;
  executable: string;
  argv: string[];
  cwd: string;
  parentRemaining: Record<BudgetDimension, number>;
  parentScope: SubagentScope;
  requestedBudget?: Partial<Record<BudgetDimension, number>>;
  requestedScope?: Partial<SubagentScope>;
}

export interface SubagentStartResult {
  receipt: SubagentStartReceipt;
  worktreePath: string;
  budget: Record<BudgetDimension, number>;
  scope: SubagentScope;
}

export class SubagentService {
  constructor(private readonly host: SubagentHost, private readonly worktrees: WorktreeManager) {}

  async start(request: SubagentStartRequest, signal: AbortSignal): Promise<OperationResult<SubagentStartResult>> {
    const added = await this.worktrees.add(request.taskId, request.baseCommit);
    if (!added.ok) return added;
    const ownedScope = narrowScope(request.parentScope, request.requestedScope ?? {});
    const receipt = await this.host.start({
      taskId: request.taskId,
      executable: request.executable,
      argv: request.argv,
      cwd: added.value.path,
    }, signal);
    if (!receipt.ok) {
      await this.worktrees.remove(request.taskId);
      return receipt;
    }
    return {
      ok: true,
      value: {
        receipt: receipt.value,
        worktreePath: added.value.path,
        budget: narrowBudgets(request.parentRemaining, request.requestedBudget ?? {}),
        scope: ownedScope,
      },
    };
  }

  async stop(receipt: SubagentStartReceipt, lineage: string[], worktreeTaskId: string): Promise<OperationResult<SubagentStopReceipt>> {
    const stopped = await this.host.stop(receipt, lineage);
    await this.worktrees.remove(worktreeTaskId);
    return stopped;
  }

  /** shared-readonly：从 ToolCatalog 删除全部 write/network/process/browser-desktop 工具 */
  isReadOnlyToolId(toolId: string): boolean {
    return !/^(fs_write|fs_edit|fs_delete|http_|browser_|process_|computer_|network_)/.test(toolId);
  }
}

/** ownedFiles 在 effect normalization 后、PDP 前逐文件校验（越界 → OWNED_FILE_SCOPE_DENIED） */
export function assertOwnedFileScope(ownedFiles: readonly string[], effectFiles: readonly string[]): OperationResult<void> {
  const escaped = effectFiles.filter(file =>
    !ownedFiles.some(scope => file === scope || file.startsWith(`${scope}/`)));
  return escaped.length === 0 ? { ok: true, value: undefined } : fail('OWNED_FILE_SCOPE_DENIED', { escaped: escaped.slice(0, 10) });
}
