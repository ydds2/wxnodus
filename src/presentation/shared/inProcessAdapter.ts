// src/presentation/shared/inProcessAdapter.ts — 共享进程内 adapter（CLI/TUI/Wire 共用委托）
import { randomUUID } from 'node:crypto';
import type { GatewayService } from '../../application/gatewayService.js';
import type { GatewayEventSource } from '../../protocol/events.js';

export function createSharedAdapter(service: GatewayService, source: GatewayEventSource, restoredSessionId: string) {
  let sessionId = restoredSessionId;
  return {
    bindSession(next: string) { sessionId = next; },
    request(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; correlationId?: string } = {}) {
      return service.request({ method, params, sessionId, source, signal: options.signal, correlationId: options.correlationId ?? randomUUID() });
    },
    subscribe: service.subscribe,
  };
}
