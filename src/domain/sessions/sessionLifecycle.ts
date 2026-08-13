// src/domain/sessions/sessionLifecycle.ts — 会话生命周期事件（唯一 envelope：W1 GatewayEvent<T>）
import type { GatewayEvent } from '../../protocol/events.js';

export type SessionLifecyclePayload =
  | { kind: 'session.start'; lifecycleRevision: 1 }
  | { kind: 'session.resume'; lifecycleRevision: number }
  | { kind: 'run.start'; lifecycleRevision: number }
  | { kind: 'turn.start'; lifecycleRevision: number };
export type SessionLifecycleEvent = GatewayEvent<SessionLifecyclePayload>;
export type LifecycleBase = Omit<GatewayEvent<never>, 'schemaVersion'|'type'|'sessionId'|'runId'|'turnId'|'payload'>;
