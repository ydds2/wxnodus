// src/bootstrap/tuiRouting.ts — Wave 3 TUI 第 1 步：TUI 装配组合路由决策
// modern/required 请求在 WxGatewayKernel 缩为 presentation adapter（TUI 不再直接访问
// DB/agent/memory、resume 走真实 session）完成前 fail-closed（TUI_MODERN_UNAVAILABLE）；
// legacy/shadow 走现有 TUI 装配。
import {
  resolveCompositionRouting,
  type CompositionRoutingSnapshot,
} from './compositionRouting.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

export type TuiCapabilityRoute = 'legacy' | 'modern';

export interface TuiRouteDecision {
  route: TuiCapabilityRoute;
  snapshot: CompositionRoutingSnapshot;
  reason: string;
}

// WxGatewayKernel → presentation adapter 的收缩状态——Wave 3 TUI 完成（db/agent/memory 原始句柄
// 不再进入 UI 层；resume 走真实 session 工件闸门；组合根持有原始句柄）
const TUI_ADAPTER_DONE = true;

export function decideTuiRoute(input: {
  operatorFlag?: string;
  env?: string;
}): OperationResult<TuiRouteDecision> {
  const snapshot = resolveCompositionRouting({ operatorFlag: input.operatorFlag, env: input.env });
  if (!snapshot.ok) return snapshot;
  const declared = snapshot.value.capability['tui'];
  const route: TuiCapabilityRoute =
    declared === 'modern' || declared === 'required'
      ? 'modern'
      : declared === 'shadow' || declared === 'legacy'
        ? 'legacy'
        : snapshot.value.root === 'modern'
          ? 'modern'
          : 'legacy';
  if (route === 'modern' && !TUI_ADAPTER_DONE) {
    return err(
      gatewayError(
        'TUI_MODERN_UNAVAILABLE',
        'tui 能力的 modern 路由尚未完成生产接线（WxGatewayKernel 尚未缩为 presentation adapter）',
        'tui.modern.unavailable',
      ),
    );
  }
  return ok({ route, snapshot: snapshot.value, reason: `composition-root:${snapshot.value.root}` });
}
