// src/application/runs/sessionRunCoordinator.ts — 共享 Agent 的 Run 身份、FIFO 所有权与唯一终态
import type { EventBus } from '../../kernel/events.js';
import type { RunContext, RunFinalStatus } from '../../protocol/runs.js';

export interface SessionAgentPort {
  getSessionId?(): string;
  setSessionId?(sessionId: string): void;
  /** 将可变会话选择限制在当前异步 Run；生产 Agent 使用此路径，避免请求改写共享默认会话。 */
  withinSession?<T>(sessionId: string, operation: () => Promise<T>): Promise<{ value: T; activeSessionId: string }>;
  abort?(): void;
}

export interface CoordinatedRunRequest<T> {
  context: RunContext;
  /** Coordinator-local replay identity. Defaults to the public Run ID. */
  admissionId?: string;
  operation(): Promise<T>;
  classify(value: T): RunFinalStatus;
  signal?: AbortSignal;
  /** 命令可显式保留执行期间产生的 session 切换；普通 Run 始终恢复临时绑定。 */
  sessionDisposition?: 'restore' | 'preserve-change';
  /** 在终态事件落盘前提交外部状态；抛错会把成功 Run 降为 failed。 */
  beforeFinalize?(result: CoordinatedRunResult<T>): void | Promise<void>;
  /** 在 FIFO 所有权释放前投影结果，避免下一个 Run 覆盖共享 Agent 状态。 */
  beforeRelease?(result: CoordinatedRunResult<T>): void;
}

export interface CoordinatedRunResult<T> {
  context: RunContext;
  status: RunFinalStatus;
  activeSessionId?: string;
  value?: T;
  error?: string;
}

export interface SessionRunCoordinator {
  execute<T>(request: CoordinatedRunRequest<T>): Promise<CoordinatedRunResult<T>>;
  /** true 表示 ID 正在执行/排队，或仍处于完成 ID 防重放窗口。 */
  has(runId: string): boolean;
}

export interface ManagedSessionRunCoordinator extends SessionRunCoordinator {
  /** 同步关闭接纳并取消当前/排队 Run；超时则在后台继续收敛。 */
  shutdown(reason: string): Promise<void>;
}

export class RunIdentityConflictError extends Error {
  readonly code = 'RUN_ID_CONFLICT';

  constructor(runId: string) {
    super(`run id already admitted: ${runId}`);
    this.name = 'RunIdentityConflictError';
  }
}

export class RunAdmissionClosedError extends Error {
  readonly code = 'RUN_ADMISSION_CLOSED';

  constructor() {
    super('run admission is closed');
    this.name = 'RunAdmissionClosedError';
  }
}

export class RunShutdownTimeoutError extends Error {
  readonly code = 'RUN_SHUTDOWN_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`run coordinator did not drain within ${timeoutMs}ms`);
    this.name = 'RunShutdownTimeoutError';
  }
}

/**
 * 当前 Agent 仍有 session/turn/tool context 等实例级状态，因此先以进程组合根级 FIFO
 * 建立排他所有权。后续 Agent 变为每 Run 实例后，可在不改变调用协议的前提下放宽并发。
 */
export function createSessionRunCoordinator(deps: {
  agent: SessionAgentPort;
  bus: EventBus;
  completedRunIdLimit?: number;
  shutdownTimeoutMs?: number;
}): ManagedSessionRunCoordinator {
  let tail = Promise.resolve();
  let admissionClosed = false;
  let shutdownPromise: Promise<void> | undefined;
  let abortCurrentOperation: (() => void) | undefined;
  const activeAdmissionIds = new Set<string>();
  const completedAdmissionIds = new Set<string>();
  const activeRunIdCounts = new Map<string, number>();
  const completedRunIds = new Set<string>();
  const completedRunIdLimit = Math.max(0, Math.floor(deps.completedRunIdLimit ?? 4096));
  const shutdownTimeoutMs = Math.max(0, Math.floor(deps.shutdownTimeoutMs ?? 2_000));

  const rememberCompleted = (admissionId: string, runId: string) => {
    if (completedRunIdLimit === 0) return;
    completedAdmissionIds.add(admissionId);
    completedRunIds.add(runId);
    while (completedAdmissionIds.size > completedRunIdLimit) {
      const oldest = completedAdmissionIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      completedAdmissionIds.delete(oldest);
    }
    while (completedRunIds.size > completedRunIdLimit) {
      const oldest = completedRunIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      completedRunIds.delete(oldest);
    }
  };

  return {
    has: runId => (activeRunIdCounts.get(runId) ?? 0) > 0 || completedRunIds.has(runId),
    shutdown: (_reason) => {
      admissionClosed = true;
      if (!shutdownPromise) {
        abortCurrentOperation?.();
        shutdownPromise = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new RunShutdownTimeoutError(shutdownTimeoutMs)), shutdownTimeoutMs);
          void tail.then(
            () => { clearTimeout(timer); resolve(); },
            cause => { clearTimeout(timer); reject(cause); },
          );
        });
      }
      return shutdownPromise;
    },
    execute<T>(request: CoordinatedRunRequest<T>): Promise<CoordinatedRunResult<T>> {
      const { context } = request;
      const admissionId = request.admissionId ?? context.runId;
      if (admissionClosed) throw new RunAdmissionClosedError();
      if (activeAdmissionIds.has(admissionId) || completedAdmissionIds.has(admissionId)) {
        throw new RunIdentityConflictError(context.runId);
      }
      activeAdmissionIds.add(admissionId);
      activeRunIdCounts.set(context.runId, (activeRunIdCounts.get(context.runId) ?? 0) + 1);

      let releaseSlot!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => { releaseSlot = resolve; });

      return (async () => {
        await previous;
        try {
          return await deps.bus.withinRun(context, async () => {
            const startedAt = Date.now();
            const previousSessionId = deps.agent.getSessionId?.();
            let sessionChanged = false;
            let status: RunFinalStatus = 'failed';
            let value: T | undefined;
            let error: string | undefined;
            let activeSessionId: string | undefined;
            let finalized = false;

            const finalize = () => {
              if (finalized) return;
              finalized = true;
              const finishedAt = Date.now();
              deps.bus.finalizeRun({
                runId: context.runId,
                correlationId: context.correlationId,
                sessionId: context.sessionId,
                status,
                admittedAt: context.admittedAt,
                startedAt,
                finishedAt,
                durationMs: finishedAt - startedAt,
                ...(error ? { error } : {}),
              });
            };

            let abortRequested = false;
            const abortActive = () => {
              if (abortRequested) return;
              abortRequested = true;
              deps.agent.abort?.();
            };
            try {
              if (admissionClosed || request.signal?.aborted) {
                status = 'cancelled';
              } else {
                abortCurrentOperation = abortActive;
                request.signal?.addEventListener('abort', abortActive, { once: true });
                if (deps.agent.withinSession) {
                  const scoped = await deps.agent.withinSession(context.sessionId, request.operation);
                  value = scoped.value;
                  activeSessionId = scoped.activeSessionId;
                } else {
                  if (deps.agent.setSessionId) {
                    deps.agent.setSessionId(context.sessionId);
                    sessionChanged = true;
                  }
                  value = await request.operation();
                }
                status = admissionClosed || request.signal?.aborted ? 'cancelled' : request.classify(value);
              }
            } catch (cause) {
              status = admissionClosed || request.signal?.aborted ? 'cancelled' : 'failed';
              error = String((cause as Error)?.message ?? cause).slice(0, 500);
            } finally {
              request.signal?.removeEventListener('abort', abortActive);
              if (abortCurrentOperation === abortActive) abortCurrentOperation = undefined;
              if (activeSessionId === undefined) {
                const resultingSessionId = deps.agent.getSessionId?.();
                const preserveChange = request.sessionDisposition === 'preserve-change'
                  && status === 'succeeded'
                  && resultingSessionId !== undefined
                  && resultingSessionId !== context.sessionId;
                if (sessionChanged && previousSessionId !== undefined && !preserveChange) {
                  try { deps.agent.setSessionId?.(previousSessionId); } catch { /* 终态不能被恢复失败覆盖 */ }
                }
                activeSessionId = deps.agent.getSessionId?.();
              }
            }

            let result = {
              context,
              status,
              ...(activeSessionId === undefined ? {} : { activeSessionId }),
              ...(value === undefined ? {} : { value }),
              ...(error ? { error } : {}),
            };
            if (status === 'succeeded' && request.beforeFinalize) {
              try {
                await request.beforeFinalize(result);
              } catch (cause) {
                status = 'failed';
                error = String((cause as Error)?.message ?? cause).slice(0, 500);
                if (sessionChanged && previousSessionId !== undefined) {
                  try { deps.agent.setSessionId?.(previousSessionId); } catch { /* 提交失败已决定 failed，恢复仅 best-effort */ }
                  activeSessionId = deps.agent.getSessionId?.();
                }
                result = {
                  context,
                  status,
                  ...(activeSessionId === undefined ? {} : { activeSessionId }),
                  ...(value === undefined ? {} : { value }),
                  error,
                };
              }
            }
            try { request.beforeRelease?.(result); } catch { /* 投影失败不能改变已确定终态 */ }
            finalize();
            return result;
          });
        } finally {
          activeAdmissionIds.delete(admissionId);
          const remaining = (activeRunIdCounts.get(context.runId) ?? 1) - 1;
          if (remaining > 0) activeRunIdCounts.set(context.runId, remaining);
          else activeRunIdCounts.delete(context.runId);
          rememberCompleted(admissionId, context.runId);
          releaseSlot();
        }
      })();
    },
  };
}
