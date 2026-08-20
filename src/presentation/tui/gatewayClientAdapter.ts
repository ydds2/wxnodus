// src/presentation/tui/gatewayClientAdapter.ts — sidecar GatewayClient 表面 → 协议 GatewayPort 适配
// 结构类型约束（不依赖 wxnodus-ui 具体类）：request/on/off 三要素缺失即 GATEWAY_CONTRACT_MISMATCH（fail closed）
import type { GatewayEvent } from '../../protocol/events.js';
import type { GatewayPort } from '../../protocol/gateway.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface GatewayClientSurface {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: 'event', handler: (ev: unknown) => void): unknown;
  off(event: 'event', handler: (ev: unknown) => void): unknown;
}

const mismatch = (): OperationResult<never> => ({
  ok: false,
  error: { code: 'GATEWAY_CONTRACT_MISMATCH', message: 'gateway client surface must expose request/on/off', messageKey: 'GATEWAY_CONTRACT_MISMATCH', retryable: false },
});

export function assertGatewayClientContract(client: unknown): OperationResult<GatewayClientSurface> {
  if (typeof client !== 'object' || client === null) return mismatch();
  const surface = client as Partial<GatewayClientSurface>;
  if (typeof surface.request !== 'function' || typeof surface.on !== 'function' || typeof surface.off !== 'function') return mismatch();
  return ok(client as GatewayClientSurface);
}

/** sidecar 事件（snake_case，无 envelope）→ 协议 GatewayEvent（缺失字段补契约默认值） */
export const toProtocolGatewayEvent = (ev: unknown): GatewayEvent | null => {
  if (typeof ev !== 'object' || ev === null) return null;
  const side = ev as { type?: unknown; payload?: unknown; timestamp?: unknown; session_id?: unknown; correlation_id?: unknown };
  if (typeof side.type !== 'string' || !side.type) return null;
  return {
    schemaVersion: 1,
    type: side.type,
    producer: 'gateway',
    timestamp: typeof side.timestamp === 'string' ? side.timestamp : '1970-01-01T00:00:00.000Z',
    locale: 'zh-CN',
    source: 'tui',
    capabilities: [],
    policySnapshotId: 'sidecar',
    correlationId: typeof side.correlation_id === 'string' ? side.correlation_id : side.type,
    sensitivity: 'internal',
    retention: side.type === 'run.completed' ? 'audit' : 'session',
    ...(typeof side.session_id === 'string' ? { sessionId: side.session_id } : {}),
    payload: side.payload,
  };
};

/** 把 sidecar client 包装为协议 GatewayPort：RPC 异常映射为 GATEWAY_CONTRACT_MISMATCH（绝不让 UI 静默吞掉） */
export function createGatewayPortFromClient(client: GatewayClientSurface): GatewayPort {
  return {
    async request(method, params, options) {
      void options;
      try {
        return ok(await client.request(method, (params ?? {}) as Record<string, unknown>));
      } catch (error) {
        return err({
          code: 'GATEWAY_CONTRACT_MISMATCH',
          message: `gateway request ${String(method)} failed: ${(error as Error)?.message ?? String(error)}`,
          messageKey: 'GATEWAY_CONTRACT_MISMATCH',
          retryable: false,
        });
      }
    },
    subscribe(handler) {
      const wrapped = (ev: unknown) => {
        const protocolEvent = toProtocolGatewayEvent(ev);
        if (protocolEvent) handler(protocolEvent);
      };
      client.on('event', wrapped);
      return () => { client.off('event', wrapped); };
    },
  };
}
