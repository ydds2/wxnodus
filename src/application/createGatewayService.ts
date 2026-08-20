// src/application/createGatewayService.ts — W2-02：GatewayService 分派器实现
// 所有 presentation adapter 的唯一委托目标：统一传播 source/session/correlation/signal；
// 未知 method 稳定失败（GATEWAY_METHOD_UNKNOWN），绝不回退 legacy；handler 异常 fail-closed（GATEWAY_METHOD_FAILED）。
import type { GatewayEvent } from '../protocol/events.js';
import { gatewayError } from '../protocol/errors.js';
import { err, type OperationResult } from '../protocol/results.js';
import type { GatewayService, GatewayServiceRequest } from './gatewayService.js';

export type GatewayMethodHandler = (request: GatewayServiceRequest) => Promise<OperationResult<unknown>>;

export function createGatewayService(handlers: Readonly<Record<string, GatewayMethodHandler>>): GatewayService {
  const subscribers = new Set<(event: GatewayEvent) => void>();

  return {
    async request(request: GatewayServiceRequest): Promise<OperationResult<unknown>> {
      const handler = handlers[request.method];
      if (typeof handler !== 'function') {
        return err(gatewayError('GATEWAY_METHOD_UNKNOWN', `未知 gateway method：${request.method}`, 'gateway.method.unknown', {
          retryable: false,
          details: { method: request.method },
        }));
      }
      try {
        return await handler(request);
      } catch (cause) {
        return err(gatewayError('GATEWAY_METHOD_FAILED', `gateway method 执行失败：${request.method}`, 'gateway.method.failed', {
          retryable: false,
          details: { method: request.method, cause: String(cause) },
        }));
      }
    },
    subscribe(handler: (event: GatewayEvent) => void): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    // 内部事件发布（adapter 装配层使用）：订阅者按注册序收到事件
    publish(event: GatewayEvent): void {
      for (const handler of subscribers) {
        try {
          handler(event);
        } catch {
          // 订阅者异常不阻断发布
        }
      }
    },
  };
}
