// src/protocol/runs.ts — Run 身份与终态协议（CompletionGate 唯一信任的状态集）
import { randomUUID } from 'node:crypto';
import type { GatewayEventSource } from './events.js';

export const RUN_FINAL_STATUSES = ['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled'] as const;
export type RunFinalStatus = (typeof RUN_FINAL_STATUSES)[number];

export interface RunContext {
  readonly runId: string;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly source: GatewayEventSource;
  readonly admittedAt: number;
}

export interface RunContextInput {
  runId?: string;
  correlationId?: string;
  sessionId: string;
  actorId?: string;
  source?: GatewayEventSource;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function isRunIdentifier(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

/** Session ID 会进入 Windows 路径组件，语法必须同时排除穿越、ADS 和设备保留名。 */
export function isSessionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value) && !WINDOWS_DEVICE_NAME.test(value);
}

/** 在请求接纳点冻结身份；非法客户端身份不得进入执行队列。 */
export function createRunContext(input: RunContextInput): RunContext {
  const runId = input.runId ?? randomUUID();
  const correlationId = input.correlationId ?? randomUUID();
  if (!isRunIdentifier(runId)) throw new TypeError('RUN_ID_INVALID');
  if (!isRunIdentifier(correlationId)) throw new TypeError('CORRELATION_ID_INVALID');
  if (!isSessionIdentifier(input.sessionId)) throw new TypeError('SESSION_ID_INVALID');
  return Object.freeze({
    runId,
    correlationId,
    sessionId: input.sessionId,
    actorId: input.actorId ?? 'actor:local',
    source: input.source ?? 'kernel',
    admittedAt: Date.now(),
  });
}

export function isRunFinalStatus(value: string): value is RunFinalStatus {
  return (RUN_FINAL_STATUSES as readonly string[]).includes(value);
}

export interface AgentRunCompletion {
  ok: boolean;
  interrupted?: boolean;
  status?: string;
}

/** Agent 兼容结果到六终态的唯一归一化入口。 */
export function normalizeAgentRunStatus(result: AgentRunCompletion): RunFinalStatus {
  if (result.interrupted) return 'cancelled';
  if (result.status && isRunFinalStatus(result.status)) return result.status;
  return result.ok ? 'succeeded' : 'failed';
}

/** 多个嵌套 Run 的保守聚合：只有全部成功才允许父 Run 成功。 */
export function aggregateRunFinalStatuses(statuses: readonly RunFinalStatus[]): RunFinalStatus {
  if (!statuses.length) return 'inconclusive';
  if (statuses.includes('cancelled')) return 'cancelled';
  if (statuses.every(status => status === 'succeeded')) return 'succeeded';
  if (statuses.some(status => status === 'succeeded')) return 'incomplete';
  if (statuses.every(status => status === 'blocked')) return 'blocked';
  if (statuses.every(status => status === 'inconclusive')) return 'inconclusive';
  return 'failed';
}
