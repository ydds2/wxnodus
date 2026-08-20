// src/application/memory/memoryGatewayMethods.ts — W3 Memory：读写入口统一为 Gateway methods
// scope 只由 GatewayServiceRequest.sessionId（可信请求上下文）构造；params 不携带/不可伪造 scope
// （P0-05 权威：input 只提供内容与查询词——调用方无法借参数逃逸到其它会话）。
import type { GatewayMethodHandler } from '../createGatewayService.js';
import type { MemoryService } from '../memoryService.js';

export interface MemoryGatewayPorts {
  /** 由可信 request.sessionId 构造 scope-bound 服务（装配层闭包——每个 session 一个权威视图） */
  serviceFor(sessionId: string): MemoryService;
  now?: () => string;
}

const textOf = (params: Record<string, unknown>, key: string, fallback = '') => {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
};

export function createMemoryGatewayMethods(ports: MemoryGatewayPorts): Record<string, GatewayMethodHandler> {
  return {
    'memory.append': async request => {
      const service = ports.serviceFor(request.sessionId);
      const text = textOf(request.params, 'text');
      if (!text) {
        return { ok: false, error: { code: 'MEMORY_TEXT_REQUIRED', message: 'memory.append 需要 text', messageKey: 'memory.text_required', retryable: false } };
      }
      return service.append({
        role: 'user',
        content: text,
        salience: 0.5,
        retention: { class: 'session', retainUntil: null },
        provenance: {
          sourceType: 'conversation',
          sourceId: request.sessionId,
          sourceUri: textOf(request.params, 'source', 'gateway') || undefined,
          capturedAt: (ports.now ?? (() => new Date().toISOString()))(),
          actorId: request.sessionId,
          correlationId: request.correlationId,
          policySnapshotId: 'gateway',
          sourceTrust: 1,
        },
      });
    },
    'memory.update': async request => {
      const service = ports.serviceFor(request.sessionId);
      const id = textOf(request.params, 'id');
      const text = textOf(request.params, 'text');
      if (!id || !text) {
        return { ok: false, error: { code: 'MEMORY_UPDATE_INPUT_INVALID', message: 'memory.update 需要 id 与 text', messageKey: 'memory.update_input_invalid', retryable: false } };
      }
      return service.update(id, { content: text });
    },
    'memory.delete': async request => {
      const service = ports.serviceFor(request.sessionId);
      const id = textOf(request.params, 'id');
      if (!id) {
        return { ok: false, error: { code: 'MEMORY_DELETE_INPUT_INVALID', message: 'memory.delete 需要 id', messageKey: 'memory.delete_input_invalid', retryable: false } };
      }
      return service.delete(id);
    },
    'memory.search': async request => {
      const service = ports.serviceFor(request.sessionId);
      const text = textOf(request.params, 'text');
      if (!text) {
        return { ok: false, error: { code: 'MEMORY_SEARCH_TEXT_REQUIRED', message: 'memory.search 需要 text', messageKey: 'memory.search_text_required', retryable: false } };
      }
      const limit = typeof request.params.limit === 'number' && request.params.limit > 0 ? Math.floor(request.params.limit) : 10;
      return service.search({ text, limit });
    },
  };
}
