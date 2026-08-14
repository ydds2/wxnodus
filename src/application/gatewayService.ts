// src/application/gatewayService.ts — 统一 Gateway 服务端口（所有 presentation adapter 的唯一委托目标）
import type { GatewayEvent, GatewayEventSource } from '../protocol/events.js';
import type { OperationResult } from '../protocol/results.js';

export interface GatewayServiceRequest {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
  source: GatewayEventSource;
  correlationId: string;
  signal?: AbortSignal;
}

export interface GatewayService {
  request(request: GatewayServiceRequest): Promise<OperationResult<unknown>>;
  subscribe(handler: (event: GatewayEvent) => void): () => void;
  /** 事件发布（装配层使用）；纯委托 adapter 可不实现 */
  publish?(event: GatewayEvent): void;
}
