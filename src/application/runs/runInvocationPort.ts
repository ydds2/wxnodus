// src/application/runs/runInvocationPort.ts — 顶层 Agent/Command Run 的唯一接纳端口
import type { CommandExecutionContext, ExecResult } from '../../app/CommandBus.js';
import type { GatewayEventSource } from '../../protocol/events.js';
import { resolveAlias } from '../../kernel/commandLevels.js';
import {
  createRunContext,
  normalizeAgentRunStatus,
  type AgentRunCompletion,
  type RunContext,
  type RunFinalStatus,
} from '../../protocol/runs.js';
import type {
  CoordinatedRunResult,
  SessionRunCoordinator,
} from './sessionRunCoordinator.js';

export interface RunAdmission {
  runId?: string;
  /** Internal coordinator replay key; protocol adapters may namespace public Run IDs. */
  admissionId?: string;
  correlationId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  actorId?: string;
  source?: GatewayEventSource;
}

export interface InvokedAgentResult extends AgentRunCompletion {
  text: string;
  turns: number;
}

export interface AgentRunInvocation extends RunAdmission {
  kind: 'agent';
  prompt: string;
  options?: {
    images?: Array<{ dataUrl: string; mime: string }>;
    goalLoop?: boolean;
  };
  beforeFinalize?(result: CoordinatedRunResult<InvokedAgentResult>): void | Promise<void>;
  beforeRelease?(result: CoordinatedRunResult<InvokedAgentResult>): void;
}

export interface CommandRunInvocation extends RunAdmission {
  kind: 'command';
  command: string;
  beforeFinalize?(result: CoordinatedRunResult<ExecResult>): void | Promise<void>;
  beforeRelease?(result: CoordinatedRunResult<ExecResult>): void;
}

/** TUI 等非命令会话操作也必须经过共享 Agent 的同一 FIFO 所有权。 */
export interface SessionRunInvocation<T> extends RunAdmission {
  kind: 'session';
  /** 成功后切换到该会话；省略表示只在 FIFO 内执行会话存储操作。 */
  targetSessionId?: string;
  operation(context: { signal: AbortSignal }): Promise<T> | T;
  classify(value: T): RunFinalStatus;
  beforeFinalize?(result: CoordinatedRunResult<T>): void | Promise<void>;
  beforeRelease?(result: CoordinatedRunResult<T>): void;
}

export interface RunInvocationHandle<T> {
  readonly context: RunContext;
  readonly completion: Promise<CoordinatedRunResult<T>>;
  cancel(): void;
}

export interface RunInvocationPort {
  invoke(request: AgentRunInvocation): RunInvocationHandle<InvokedAgentResult>;
  invoke(request: CommandRunInvocation): RunInvocationHandle<ExecResult>;
  invoke<T>(request: SessionRunInvocation<T>): RunInvocationHandle<T>;
  has(runId: string): boolean;
}

export function createRunInvocationPort(deps: {
  coordinator: SessionRunCoordinator;
  agent: {
    getSessionId?(): string;
    setSessionId?(sessionId: string): void;
    withinSession?<T>(sessionId: string, operation: () => Promise<T>): Promise<{ value: T; activeSessionId: string }>;
    run(prompt: string, options?: AgentRunInvocation['options'] & { runContext?: RunContext }): Promise<InvokedAgentResult>;
  };
  executeCommand(input: string, context: CommandExecutionContext & { signal: AbortSignal }): Promise<ExecResult>;
}): RunInvocationPort {
  function invokeAgent(request: AgentRunInvocation): RunInvocationHandle<InvokedAgentResult> {
    const context = createRunContext({
      runId: request.runId,
      correlationId: request.correlationId,
      sessionId: request.sessionId ?? deps.agent.getSessionId?.() ?? 'default',
      actorId: request.actorId,
      source: request.source,
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (request.signal?.aborted) cancel();
    else request.signal?.addEventListener('abort', cancel, { once: true });

    const completion = deps.coordinator.execute<InvokedAgentResult>({
      context,
      admissionId: request.admissionId,
      signal: controller.signal,
      operation: () => deps.agent.run(request.prompt, { ...request.options, runContext: context }),
      classify: normalizeAgentRunStatus,
      beforeFinalize: request.beforeFinalize,
      beforeRelease: request.beforeRelease,
    }).finally(() => request.signal?.removeEventListener('abort', cancel));
    return { context, completion, cancel };
  }

  function invokeCommand(request: CommandRunInvocation): RunInvocationHandle<ExecResult> {
    const context = createRunContext({
      runId: request.runId,
      correlationId: request.correlationId,
      sessionId: request.sessionId ?? deps.agent.getSessionId?.() ?? 'default',
      actorId: request.actorId,
      source: request.source,
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (request.signal?.aborted) cancel();
    else request.signal?.addEventListener('abort', cancel, { once: true });

    const commandName = resolveAlias(request.command.trim().split(/\s+/, 1)[0] ?? '');
    const completion = deps.coordinator.execute({
      context,
      admissionId: request.admissionId,
      signal: controller.signal,
      sessionDisposition: commandName === '/resume' || commandName === '/new'
        ? 'preserve-change'
        : 'restore',
      operation: () => deps.executeCommand(request.command, { signal: controller.signal, runContext: context }),
      classify: value => value.completionStatus ?? (value.ok ? 'succeeded' : 'failed'),
      beforeFinalize: request.beforeFinalize,
      beforeRelease: request.beforeRelease,
    }).finally(() => request.signal?.removeEventListener('abort', cancel));
    return { context, completion, cancel };
  }

  function invokeSession<T>(request: SessionRunInvocation<T>): RunInvocationHandle<T> {
    const context = createRunContext({
      runId: request.runId,
      correlationId: request.correlationId,
      sessionId: request.sessionId ?? deps.agent.getSessionId?.() ?? 'default',
      actorId: request.actorId,
      source: request.source,
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (request.signal?.aborted) cancel();
    else request.signal?.addEventListener('abort', cancel, { once: true });

    let operationStatus: RunFinalStatus | undefined;
    const completion = deps.coordinator.execute<T>({
      context,
      admissionId: request.admissionId,
      signal: controller.signal,
      sessionDisposition: request.targetSessionId ? 'preserve-change' : 'restore',
      operation: async () => {
        const value = await request.operation({ signal: controller.signal });
        operationStatus = request.classify(value);
        if (!controller.signal.aborted && request.targetSessionId && operationStatus === 'succeeded') {
          deps.agent.setSessionId?.(request.targetSessionId);
        }
        return value;
      },
      classify: value => operationStatus ?? request.classify(value),
      beforeFinalize: request.beforeFinalize,
      beforeRelease: request.beforeRelease,
    }).finally(() => request.signal?.removeEventListener('abort', cancel));
    return { context, completion, cancel };
  }

  return {
    invoke<T>(request: AgentRunInvocation | CommandRunInvocation | SessionRunInvocation<T>) {
      if (request.kind === 'agent') return invokeAgent(request);
      if (request.kind === 'command') return invokeCommand(request);
      return invokeSession(request);
    },
    has: runId => deps.coordinator.has(runId),
  } as RunInvocationPort;
}
