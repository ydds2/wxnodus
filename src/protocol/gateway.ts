// src/protocol/gateway.ts — Gateway Port（Presentation 依赖的唯一内核入口契约）
import type { GatewayEvent } from './events.js';
import type { OperationResult } from './results.js';

export interface GatewayRequestOptions {
  signal?: AbortSignal;
  correlationId?: string;
}

export interface GatewayMethodMap {
  [method: string]: { params: unknown; value: unknown };
}

export interface GatewayPort<M extends GatewayMethodMap = GatewayMethodMap> {
  request<K extends keyof M & string>(
    method: K,
    params: M[K]['params'],
    options?: GatewayRequestOptions,
  ): Promise<OperationResult<M[K]['value']>>;
  subscribe(handler: (event: GatewayEvent) => void): () => void;
}
