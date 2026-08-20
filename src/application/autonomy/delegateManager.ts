// src/application/autonomy/delegateManager.ts — 组合根级现代子代理生命周期
import type { EventBus } from '../../kernel/events.js';
import type { OperationResult } from '../../protocol/results.js';
import {
  createRunContext,
  type RunContext,
  type RunFinalStatus,
} from '../../protocol/runs.js';

export interface DelegateProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface DelegateProcessHandle {
  processId: number;
  completion: Promise<DelegateProcessResult>;
  terminate(deadlineMs: number): Promise<OperationResult<void>>;
}

export type DelegateLifecycleStatus = 'running' | 'stopping' | 'cleanup_failed';

export interface DelegateSnapshot {
  taskId: string;
  processId: number;
  goal: string;
  worktreePath: string;
  startedAt: number;
  runContext: RunContext;
  status: DelegateLifecycleStatus;
}

export interface DelegateStartRequest {
  goal: string;
  parentContext?: RunContext;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface DelegateStopResult {
  ok: boolean;
  taskId: string;
  status: RunFinalStatus;
  error?: string;
}

export interface DelegateManager {
  start(request: DelegateStartRequest): Promise<OperationResult<DelegateSnapshot>>;
  stop(taskId: string, reason?: string): Promise<DelegateStopResult>;
  listActive(): DelegateSnapshot[];
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  shutdown(reason: string): Promise<void>;
}

interface PendingFinal {
  status: RunFinalStatus;
  result?: DelegateProcessResult;
  error: string;
}

interface ActiveDelegate extends Omit<DelegateSnapshot, 'status'> {
  status: DelegateLifecycleStatus;
  controller: AbortController;
  process: DelegateProcessHandle;
  lineage: string[];
  timeout?: NodeJS.Timeout;
  finalized: boolean;
  finalStatus?: RunFinalStatus;
  finalization?: Promise<FinalizeResult>;
  pendingFinal?: PendingFinal;
  stopRequest?: { status: RunFinalStatus; reason: string };
  stopAttempt?: Promise<DelegateStopResult>;
  parentSignal?: AbortSignal;
  parentAbort?: () => void;
}

interface FinalizeResult {
  finalized: boolean;
  status: RunFinalStatus;
  error: string;
}

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

const joinErrors = (...values: Array<string | undefined>): string =>
  values.filter(Boolean).join('; ');

export function createDelegateManager(deps: {
  bus: EventBus;
  worktrees: {
    add(taskId: string, baseCommit: string): Promise<OperationResult<{ path: string }>>;
    remove(taskId: string): Promise<OperationResult<void>>;
  };
  process: {
    start(
      goal: string,
      cwd: string,
      signal: AbortSignal,
      sessionId: string,
    ): Promise<OperationResult<DelegateProcessHandle>>;
  };
  fence(lineage: string[]): Promise<OperationResult<void>>;
  timeoutMs?: number;
  stopDeadlineMs?: number;
  now?: () => number;
  idFactory?: () => string;
}): DelegateManager {
  const active = new Map<string, ActiveDelegate>();
  const inFlightStarts = new Set<Promise<void>>();
  const orphanWorktrees = new Set<string>();
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const stopDeadlineMs = deps.stopDeadlineMs ?? 5_000;
  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? (() => `sub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  let paused = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;

  const snapshot = (task: ActiveDelegate): DelegateSnapshot => ({
    taskId: task.taskId,
    processId: task.processId,
    goal: task.goal,
    worktreePath: task.worktreePath,
    startedAt: task.startedAt,
    runContext: task.runContext,
    status: task.status,
  });

  const detachParent = (task: ActiveDelegate): void => {
    if (task.parentSignal && task.parentAbort) {
      task.parentSignal.removeEventListener('abort', task.parentAbort);
    }
  };

  const emitFinal = (task: ActiveDelegate, pending: PendingFinal): void => {
    if (task.finalized) return;
    task.finalized = true;
    task.finalStatus = pending.status;
    if (task.timeout) clearTimeout(task.timeout);
    detachParent(task);
    const finishedAt = now();
    active.delete(task.taskId);
    deps.bus.withinRun(task.runContext, () => {
      deps.bus.emit('agent.subagent', {
        subagent_id: task.taskId,
        goal: task.goal,
        phase: 'complete',
        ok: pending.status === 'succeeded',
        status: pending.status,
        output: pending.result?.stdout ?? '',
        error: pending.error || pending.result?.stderr || undefined,
      });
      deps.bus.finalizeRun({
        runId: task.runContext.runId,
        correlationId: task.runContext.correlationId,
        sessionId: task.runContext.sessionId,
        status: pending.status,
        admittedAt: task.runContext.admittedAt,
        startedAt: task.startedAt,
        finishedAt,
        durationMs: finishedAt - task.startedAt,
        ...(pending.error ? { error: pending.error } : {}),
      });
    });
  };

  const attemptFinalize = (
    task: ActiveDelegate,
    requested: PendingFinal,
  ): Promise<FinalizeResult> => {
    if (task.finalized) {
      return Promise.resolve({ finalized: true, status: task.finalStatus ?? requested.status, error: '' });
    }
    if (task.finalization) return task.finalization;
    const pending = task.pendingFinal ?? requested;
    task.pendingFinal = pending;
    task.finalization = (async () => {
      const removed = await deps.worktrees.remove(task.taskId);
      if (!removed.ok) {
        const error = joinErrors(pending.error, removed.error.code);
        task.pendingFinal = { ...pending, status: 'failed', error };
        task.status = 'cleanup_failed';
        return { finalized: false, status: 'failed' as const, error };
      }
      task.pendingFinal = undefined;
      emitFinal(task, pending);
      return { finalized: true, status: pending.status, error: pending.error };
    })().finally(() => {
      task.finalization = undefined;
    });
    return task.finalization;
  };

  const processCompleted = async (
    task: ActiveDelegate,
    result?: DelegateProcessResult,
    cause?: unknown,
  ): Promise<void> => {
    if (task.finalized || task.pendingFinal) return;
    if (task.stopRequest) {
      await attemptFinalize(task, {
        status: task.stopRequest.status,
        result,
        error: task.stopRequest.reason,
      });
      return;
    }
    const status: RunFinalStatus = cause === undefined && result?.exitCode === 0 ? 'succeeded' : 'failed';
    const error = cause !== undefined
      ? String((cause as Error)?.message ?? cause).slice(0, 500)
      : status === 'failed'
        ? result?.stderr || `子进程退出码 ${result?.exitCode ?? '?'}${result?.signal ? `（${result.signal}）` : ''}`
        : '';
    await attemptFinalize(task, { status, result, error });
  };

  const stopTask = (
    task: ActiveDelegate,
    status: RunFinalStatus,
    reason: string,
  ): Promise<DelegateStopResult> => {
    if (task.stopAttempt) return task.stopAttempt;
    const attempt: Promise<DelegateStopResult> = (async (): Promise<DelegateStopResult> => {
      if (task.finalized) {
        return {
          ok: task.finalStatus === status,
          taskId: task.taskId,
          status: task.finalStatus ?? 'inconclusive',
        };
      }
      if (task.pendingFinal) {
        const retried = await attemptFinalize(task, task.pendingFinal);
        return {
          ok: retried.finalized && retried.status === status,
          taskId: task.taskId,
          status: retried.status,
          ...(!retried.finalized || retried.status !== status ? { error: retried.error || 'WORKTREE_REMOVE_FAILED' } : {}),
        };
      }

      task.status = 'stopping';
      task.stopRequest = { status, reason };
      if (task.timeout) clearTimeout(task.timeout);
      const fenced = await deps.fence(task.lineage);
      task.controller.abort(reason);
      const terminated = await task.process.terminate(stopDeadlineMs);
      if (!terminated.ok) {
        return {
          ok: false,
          taskId: task.taskId,
          status: 'failed',
          error: terminated.error.code,
        };
      }

      const requestedStatus: RunFinalStatus = fenced.ok ? status : 'failed';
      const requestedError = fenced.ok ? reason : joinErrors(reason, fenced.error.code);
      const finalized = await attemptFinalize(task, {
        status: requestedStatus,
        error: requestedError,
      });
      return {
        ok: finalized.finalized && finalized.status === status,
        taskId: task.taskId,
        status: finalized.status,
        ...(!finalized.finalized || finalized.status !== status ? { error: finalized.error || 'SUBAGENT_STOP_FAILED' } : {}),
      };
    })();
    const tracked = attempt.finally(() => {
      task.stopAttempt = undefined;
    });
    task.stopAttempt = tracked;
    return tracked;
  };

  const stop = async (taskId: string, reason = '用户终止'): Promise<DelegateStopResult> => {
    const task = active.get(taskId);
    if (!task) return { ok: false, taskId, status: 'inconclusive', error: 'SUBAGENT_NOT_RUNNING' };
    return stopTask(task, 'cancelled', reason);
  };

  const cleanupUnadmittedWorktree = async (taskId: string): Promise<void> => {
    const removed = await deps.worktrees.remove(taskId);
    if (!removed.ok) orphanWorktrees.add(taskId);
  };

  const startOwned = async (request: DelegateStartRequest): Promise<OperationResult<DelegateSnapshot>> => {
    if (!request.goal.trim()) return fail('SUBAGENT_GOAL_REQUIRED');
    if (request.signal?.aborted) return fail('SUBAGENT_ABORTED');

    const taskId = idFactory();
    const controller = new AbortController();
    const parentAbort = () => {
      controller.abort(request.signal?.reason ?? '父 Run 已取消');
      const task = active.get(taskId);
      if (task) void stopTask(task, 'cancelled', '父 Run 已取消');
    };
    request.signal?.addEventListener('abort', parentAbort, { once: true });

    const added = await deps.worktrees.add(taskId, 'HEAD');
    if (!added.ok) {
      request.signal?.removeEventListener('abort', parentAbort);
      return added;
    }
    if (controller.signal.aborted || closing) {
      request.signal?.removeEventListener('abort', parentAbort);
      await cleanupUnadmittedWorktree(taskId);
      return fail(closing ? 'SUBAGENT_MANAGER_CLOSED' : 'SUBAGENT_ABORTED');
    }

    const childSessionId = request.sessionId ?? request.parentContext?.sessionId ?? `delegate-${taskId}`;
    const launched = await deps.process.start(
      request.goal.trim(),
      added.value.path,
      controller.signal,
      childSessionId,
    );
    if (!launched.ok) {
      request.signal?.removeEventListener('abort', parentAbort);
      await cleanupUnadmittedWorktree(taskId);
      return launched;
    }

    const startedAt = now();
    const runContext = createRunContext({
      runId: `delegate:${taskId}`,
      correlationId: request.parentContext?.correlationId ?? `delegate:${taskId}`,
      sessionId: childSessionId,
    });
    const task: ActiveDelegate = {
      taskId,
      processId: launched.value.processId,
      goal: request.goal.trim(),
      worktreePath: added.value.path,
      startedAt,
      runContext,
      status: 'running',
      controller,
      process: launched.value,
      lineage: [...(request.parentContext ? [request.parentContext.runId] : []), runContext.runId],
      finalized: false,
      parentSignal: request.signal,
      parentAbort,
    };
    active.set(taskId, task);

    task.timeout = setTimeout(() => {
      void stopTask(task, 'failed', `执行超时（${timeoutMs}ms）`);
    }, timeoutMs);

    deps.bus.withinRun(runContext, () => {
      deps.bus.emit('agent.subagent', {
        subagent_id: taskId,
        goal: task.goal,
        phase: 'start',
        process_id: task.processId,
        worktree: task.worktreePath,
      });
    });

    void task.process.completion.then(
      result => processCompleted(task, result),
      cause => processCompleted(task, undefined, cause),
    );

    if (controller.signal.aborted || closing) {
      await stopTask(task, 'cancelled', closing ? '进程正在关闭' : '父 Run 已取消');
      return fail(closing ? 'SUBAGENT_MANAGER_CLOSED' : 'SUBAGENT_ABORTED');
    }
    return { ok: true, value: snapshot(task) };
  };

  const start = (request: DelegateStartRequest): Promise<OperationResult<DelegateSnapshot>> => {
    if (closing) return Promise.resolve(fail('SUBAGENT_MANAGER_CLOSED'));
    if (paused) return Promise.resolve(fail('SUBAGENT_DELEGATION_PAUSED'));
    let release!: () => void;
    const ownership = new Promise<void>(resolve => { release = resolve; });
    inFlightStarts.add(ownership);
    return startOwned(request).finally(() => {
      inFlightStarts.delete(ownership);
      release();
    });
  };

  const shutdown = (reason: string): Promise<void> => {
    closing = true;
    shutdownPromise ??= (async () => {
      await Promise.allSettled([...inFlightStarts]);
      await Promise.allSettled([...active.values()].map(task => stopTask(task, 'cancelled', `进程关闭：${reason}`)));
      await Promise.allSettled([...orphanWorktrees].map(async taskId => {
        const removed = await deps.worktrees.remove(taskId);
        if (removed.ok) orphanWorktrees.delete(taskId);
      }));
      const remaining = [...active.keys(), ...orphanWorktrees].sort();
      if (remaining.length) throw new Error(`SUBAGENT_SHUTDOWN_INCOMPLETE:${remaining.join(',')}`);
    })().catch(cause => {
      shutdownPromise = undefined;
      throw cause;
    });
    return shutdownPromise;
  };

  return {
    start,
    stop,
    listActive: () => [...active.values()].map(snapshot),
    setPaused(value) { paused = value; },
    isPaused: () => paused,
    shutdown,
  };
}
