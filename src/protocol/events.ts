// src/protocol/events.ts — 统一生命周期事件 envelope（所有 session/run/turn 事件必须携带）
import { gatewayError } from './errors.js';
import { err, ok, type OperationResult } from './results.js';

export type GatewayEventSource = 'cli' | 'wire' | 'http' | 'tui' | 'kernel' | 'worker';

export interface EventRedaction {
  strategy: 'drop' | 'mask' | 'hash';
  fields: readonly string[];
}

export interface GatewayEvent<T = unknown> {
  schemaVersion: 1;
  type: string;
  producer: string;
  timestamp: string;
  locale: string;
  source: GatewayEventSource;
  capabilities: readonly string[];
  policySnapshotId: string;
  correlationId: string;
  sensitivity: 'public' | 'internal' | 'secret';
  retention: 'ephemeral' | 'session' | 'audit';
  redaction?: EventRedaction;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  payload: T;
}

export type GatewayEventInput<T> = GatewayEvent<T>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function createGatewayEvent<T>(input: GatewayEventInput<T>): OperationResult<GatewayEvent<T>> {
  if (!ISO_UTC.test(input.timestamp) || Number.isNaN(Date.parse(input.timestamp))) {
    return err(gatewayError('EVENT_TIMESTAMP_INVALID', '事件时间必须是 UTC ISO-8601', 'event.timestamp.invalid'));
  }
  if (/^(session|run|turn)\./.test(input.type) && !input.sessionId) {
    return err(gatewayError('EVENT_LIFECYCLE_SESSION_REQUIRED', '生命周期事件缺少 sessionId', 'event.lifecycle.session_required'));
  }
  if (/^(run|turn)\./.test(input.type) && !input.runId) {
    return err(gatewayError('EVENT_LIFECYCLE_RUN_REQUIRED', '运行事件缺少 runId', 'event.lifecycle.run_required'));
  }
  if (/^turn\./.test(input.type) && !input.turnId) {
    return err(gatewayError('EVENT_LIFECYCLE_TURN_REQUIRED', '轮次事件缺少 turnId', 'event.lifecycle.turn_required'));
  }
  if (input.sensitivity === 'secret' && !input.redaction?.fields.length) {
    return err(gatewayError('EVENT_SECRET_REDACTION_REQUIRED', 'secret 事件必须声明 redaction', 'event.secret.redaction_required'));
  }
  if (input.sensitivity === 'secret' && input.retention !== 'audit') {
    return err(gatewayError('EVENT_SECRET_RETENTION_REQUIRED', 'secret 事件必须使用 audit retention', 'event.secret.retention_required'));
  }
  return ok(Object.freeze({ ...input, capabilities: Object.freeze([...input.capabilities]) }));
}
