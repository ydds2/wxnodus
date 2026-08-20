// src/protocol/operationContext.ts — 操作上下文（跨 Application/Domain 传递的信任边界）
import type { GatewayEventSource } from './events.js';

export interface OperationContext {
  actorId: string;
  sessionId: string;
  runId: string | null;
  correlationId: string;
  parentCorrelationId?: string;
  policySnapshotId: string;
  locale: string;
  source: GatewayEventSource;
  capabilities: readonly string[];
  timestamp: string;
}
