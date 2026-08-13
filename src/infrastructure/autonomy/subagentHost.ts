// src/infrastructure/autonomy/subagentHost.ts — W2-10：子代理进程宿主（start/stop receipt）
// cancel 沿 lineage 先 fence（W1 effect fence）再 AbortSignal，并等待 host stop receipt
import type { OperationResult } from '../../protocol/results.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface SpawnedProcess {
  processId: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface SubagentHostPorts {
  spawn(executable: string, args: string[], options: { cwd: string; timeoutMs: number }, signal: AbortSignal): Promise<SpawnedProcess>;
  terminateTree(processId: number, deadlineMs: number): Promise<OperationResult<void>>;
  /** W1 effect fence：沿 lineage 禁止新 effect（先 fence 后 abort） */
  fence(lineage: string[]): Promise<OperationResult<void>>;
}

export interface SubagentStartReceipt { taskId: string; processId: number; startedAt: string }
export interface SubagentStopReceipt { taskId: string; processId: number; stoppedAt: string; fenced: boolean }

export class SubagentHost {
  constructor(private readonly ports: SubagentHostPorts) {}

  async start(task: { taskId: string; executable: string; argv: string[]; cwd: string; timeoutMs?: number }, signal: AbortSignal): Promise<OperationResult<SubagentStartReceipt>> {
    try {
      const spawned = await this.ports.spawn(task.executable, task.argv, { cwd: task.cwd, timeoutMs: task.timeoutMs ?? 600_000 }, signal);
      if (spawned.aborted || signal.aborted) return fail('SUBAGENT_ABORTED', { taskId: task.taskId });
      if (spawned.exitCode !== null && spawned.exitCode !== 0) return fail('SUBAGENT_SPAWN_FAILED', { taskId: task.taskId, exitCode: spawned.exitCode });
      return { ok: true, value: { taskId: task.taskId, processId: spawned.processId, startedAt: new Date().toISOString() } };
    } catch (error) {
      return fail('SUBAGENT_SPAWN_FAILED', { taskId: task.taskId, message: String((error as Error)?.message ?? error) });
    }
  }

  /** 停：fence → terminateTree → 等待 host stop receipt（树未退出 → SUBAGENT_STOP_FAILED） */
  async stop(receipt: SubagentStartReceipt, lineage: string[]): Promise<OperationResult<SubagentStopReceipt>> {
    const fenced = await this.ports.fence(lineage);
    const stopped = await this.ports.terminateTree(receipt.processId, 5_000);
    if (!stopped.ok) return fail('SUBAGENT_STOP_FAILED', { taskId: receipt.taskId, processId: receipt.processId });
    return { ok: true, value: { taskId: receipt.taskId, processId: receipt.processId, stoppedAt: new Date().toISOString(), fenced: fenced.ok } };
  }

  /** cancel：先 fence 后 AbortSignal（调用方持有 controller），并返回 stop receipt */
  async cancel(receipt: SubagentStartReceipt, lineage: string[], abort: () => void): Promise<OperationResult<SubagentStopReceipt>> {
    await this.ports.fence(lineage);
    abort();
    return this.stop(receipt, lineage);
  }
}
