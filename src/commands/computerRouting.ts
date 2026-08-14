// src/commands/computerRouting.ts — Wave 3 Computer/Browser 第 1 步：能力组合路由决策
// computer（robot/UIA/computer_open）与 browser（Playwright）同构 fail-closed：
// modern/required 请求在 ComputerUseService 全入口接管（PDP/approval/postcondition/evidence）完成前
// 拒绝（COMPUTER_MODERN_UNAVAILABLE / BROWSER_MODERN_UNAVAILABLE）——绝不静默退回 legacy；
// legacy/shadow 走现有链路（shadow 不双执行副作用）。
import {
  resolveCompositionRouting,
  type CompositionRoutingSnapshot,
} from '../bootstrap/compositionRouting.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

export type ComputerCapabilityRoute = 'legacy' | 'modern';

export interface ComputerRouteDecision {
  route: ComputerCapabilityRoute;
  snapshot: CompositionRoutingSnapshot;
  reason: string;
}

// ComputerUseService 生产接线状态：wiring + 证据 store + /computer modern 分支已装配（PDP/审批桥/postcondition/evidence 全端口）
const COMPUTER_SERVICE_WIRED = true;
// Browser 接线状态：UrlPolicy 先验 + PlaywrightBrowserDriver 生产组装 + /browser modern 分支已装配
const BROWSER_SERVICE_WIRED = true;

function decideCapability(input: {
  operatorFlag?: string;
  env?: string;
  capability: string;
  wired: boolean;
  unavailableCode: string;
  unavailableMessage: string;
  unavailableKey: string;
}): OperationResult<ComputerRouteDecision> {
  const snapshot = resolveCompositionRouting({ operatorFlag: input.operatorFlag, env: input.env });
  if (!snapshot.ok) return snapshot;
  const declared = snapshot.value.capability[input.capability];
  const route: ComputerCapabilityRoute =
    declared === 'modern' || declared === 'required'
      ? 'modern'
      : declared === 'shadow' || declared === 'legacy'
        ? 'legacy'
        : snapshot.value.root === 'modern'
          ? 'modern'
          : 'legacy';
  if (route === 'modern' && !input.wired) {
    return err(gatewayError(input.unavailableCode, input.unavailableMessage, input.unavailableKey));
  }
  return ok({ route, snapshot: snapshot.value, reason: `composition-root:${snapshot.value.root}` });
}

export function decideComputerRoute(input: { operatorFlag?: string; env?: string }): OperationResult<ComputerRouteDecision> {
  return decideCapability({
    ...input,
    capability: 'computer',
    wired: COMPUTER_SERVICE_WIRED,
    unavailableCode: 'COMPUTER_MODERN_UNAVAILABLE',
    unavailableMessage: 'computer 能力的 modern 路由不可用',
    unavailableKey: 'computer.modern.unavailable',
  });
}

export function decideBrowserRoute(input: { operatorFlag?: string; env?: string }): OperationResult<ComputerRouteDecision> {
  return decideCapability({
    ...input,
    capability: 'browser',
    wired: BROWSER_SERVICE_WIRED,
    unavailableCode: 'BROWSER_MODERN_UNAVAILABLE',
    unavailableMessage: 'browser 能力的 modern 路由不可用',
    unavailableKey: 'browser.modern.unavailable',
  });
}
