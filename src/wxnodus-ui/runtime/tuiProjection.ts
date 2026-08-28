// src/wxnodus-ui/runtime/tuiProjection.ts — TUI 视图本地状态：sidecar 事件流 → 纯投影管线（presentation 纯层唯一消费点）
// 只消费 run 生命周期事件（其余事件由既有 eventAdapter 处理，不喂纯管线，避免 lastError 噪音）
import { toProtocolGatewayEvent } from '../../presentation/tui/gatewayClientAdapter.js';
import { initialTuiState, reduceTui, type TuiState } from '../../presentation/tui/state/reducer.js';
import { projectGatewayEvent } from '../../presentation/tui/state/projector.js';

let state = initialTuiState();
const listeners = new Set<() => void>();

export const getTuiProjection = (): TuiState => state;
export const subscribeTuiProjection = (callback: () => void): (() => void) => {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
};

export function feedTuiProjection(sideEvent: unknown): void {
  const protocolEvent = toProtocolGatewayEvent(sideEvent);
  if (!protocolEvent || !protocolEvent.type.startsWith('run.')) return;
  state = projectGatewayEvent(protocolEvent).reduce(reduceTui, state);
  for (const listener of listeners) listener();
}
