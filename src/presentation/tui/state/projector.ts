// src/presentation/tui/state/projector.ts — 协议事件 → TuiAction 纯投影（不支持的 run 事件稳定报 TUI_EVENT_UNSUPPORTED，绝不猜测）
import type { GatewayEvent } from '../../../protocol/events.js';
import type { TuiAction } from './reducer.js';

const terminal = new Set(['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled']);

export function projectGatewayEvent(event: GatewayEvent): TuiAction[] {
  if (event.type === 'run.started' && event.runId) return [{ type: 'run.started', runId: event.runId }];
  if (event.type === 'run.completed' && event.runId) {
    const payload = event.payload as { status?: string; reasons?: string[] };
    if (payload?.status && terminal.has(payload.status)) {
      return [{
        type: 'run.completed',
        runId: event.runId,
        status: payload.status as 'succeeded' | 'failed' | 'blocked' | 'incomplete' | 'inconclusive' | 'cancelled',
        reasons: Array.isArray(payload.reasons) ? payload.reasons : [],
      }];
    }
  }
  return [{ type: 'projection.failed', code: 'TUI_EVENT_UNSUPPORTED', eventType: event.type }];
}
