// src/commands/buildRouting.ts — Wave 3 Build 第 1 步：Build 能力组合路由决策
// modern/required 请求在 BuildService 生产接线（compileAndRun 全端口）完成前 fail-closed
// （BUILD_MODERN_UNAVAILABLE）——绝不静默退回 legacy 假成功；legacy/shadow 走现有管线
// （默认 legacy，不破坏现状；shadow 不双执行副作用——只跑 legacy 一条）。
import {
  resolveCompositionRouting,
  type CompositionRoutingSnapshot,
} from '../bootstrap/compositionRouting.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

export type BuildCapabilityRoute = 'legacy' | 'modern';

export interface BuildRouteDecision {
  route: BuildCapabilityRoute;
  snapshot: CompositionRoutingSnapshot;
  reason: string;
}

// BuildService 生产端口已接线：wiring + spec→acceptance 契约 + /build modern 分支（staging→验证→evidence→reviewer→owned receipt）
const BUILD_SERVICE_WIRED = true;

export function decideBuildRoute(input: {
  operatorFlag?: string;
  env?: string;
}): OperationResult<BuildRouteDecision> {
  const snapshot = resolveCompositionRouting({ operatorFlag: input.operatorFlag, env: input.env });
  if (!snapshot.ok) return snapshot;
  // 能力实际路由：显式声明（workspace capability 表）优先；未声明跟随根。
  const declared = snapshot.value.capability['build'];
  const route: BuildCapabilityRoute =
    declared === 'modern' || declared === 'required'
      ? 'modern'
      : declared === 'shadow' || declared === 'legacy'
        ? 'legacy'
        : snapshot.value.root === 'modern'
          ? 'modern'
          : 'legacy';
  if (route === 'modern' && !BUILD_SERVICE_WIRED) {
    return err(
      gatewayError(
        'BUILD_MODERN_UNAVAILABLE',
        'build 能力的 modern 路由不可用',
        'build.modern.unavailable',
      ),
    );
  }
  return ok({ route, snapshot: snapshot.value, reason: `composition-root:${snapshot.value.root}` });
}
