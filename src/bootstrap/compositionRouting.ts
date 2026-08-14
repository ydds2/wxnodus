// src/bootstrap/compositionRouting.ts — W2-01：不可变组合路由快照
// operator 可用 --composition-root / WXNODUS_COMPOSITION_ROOT 指定 root（legacy/shadow/modern）；
// workspace 持久化声明不得被 operator 降级（modern/deny 能力降级稳定拒绝）；未知值 fail-closed。
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

export type CompositionRoot = 'legacy' | 'shadow' | 'modern';
export type CapabilityRoute = 'legacy' | 'shadow' | 'modern' | 'required';
export type RoutingSource = 'operator-flag' | 'env' | 'workspace' | 'default';

export interface CompositionRoutingSnapshot {
  root: CompositionRoot;
  capability: Record<string, CapabilityRoute>;
  source: RoutingSource;
}

const ROOTS: readonly CompositionRoot[] = ['legacy', 'shadow', 'modern'];
const ROUTES: readonly CapabilityRoute[] = ['legacy', 'shadow', 'modern', 'required'];

export interface CompositionRoutingInput {
  operatorFlag?: string;
  env?: string;
  workspace?: { root?: CompositionRoot; capability?: Record<string, CapabilityRoute> } | null;
}

export function resolveCompositionRouting(input: CompositionRoutingInput): OperationResult<CompositionRoutingSnapshot> {
  const workspace = input.workspace ?? null;

  // operator 声明优先于 env 与 workspace；但不得降级 workspace 已固化的 modern 根
  let declared = input.operatorFlag ?? input.env;
  let source: RoutingSource = input.operatorFlag !== undefined ? 'operator-flag' : input.env !== undefined ? 'env' : 'default';

  if (declared !== undefined && !ROOTS.includes(declared as CompositionRoot)) {
    return err(gatewayError('COMPOSITION_ROOT_INVALID', `未知 composition root：${declared}`, 'composition.root.invalid'));
  }

  if (workspace?.root) {
    if (!ROOTS.includes(workspace.root)) {
      return err(gatewayError('COMPOSITION_ROOT_INVALID', `workspace 声明未知 composition root：${workspace.root}`, 'composition.root.invalid'));
    }
    if (declared !== undefined && (declared as CompositionRoot) !== workspace.root) {
      const rank: Record<CompositionRoot, number> = { legacy: 0, shadow: 1, modern: 2 };
      if (rank[declared as CompositionRoot] < rank[workspace.root]) {
        return err(gatewayError('COMPOSITION_ROOT_DOWNGRADE_DENIED', `不得把 workspace 的 ${workspace.root} 降级为 ${declared}`, 'composition.root.downgradeDenied'));
      }
      declared = workspace.root;
      source = 'workspace';
    } else if (declared === undefined) {
      declared = workspace.root;
      source = 'workspace';
    }
  }

  const capability: Record<string, CapabilityRoute> = {};
  if (workspace?.capability) {
    for (const [name, route] of Object.entries(workspace.capability)) {
      if (!ROUTES.includes(route)) {
        return err(gatewayError('CAPABILITY_ROUTE_INVALID', `能力 ${name} 路由未知：${route}`, 'composition.capability.invalid'));
      }
      capability[name] = route;
    }
  }

  const snapshot: CompositionRoutingSnapshot = Object.freeze({
    root: (declared ?? 'legacy') as CompositionRoot,
    capability: Object.freeze(capability),
    source,
  });
  return ok(snapshot);
}

/** 查询某能力的实际路由：required 不可降级；未声明时跟随 root。 */
export function resolveCapabilityRoute(
  snapshot: CompositionRoutingSnapshot,
  capability: string,
  requested: CapabilityRoute,
): OperationResult<CapabilityRoute> {
  const declared = snapshot.capability[capability];
  if (declared === 'required') {
    if (requested === 'legacy' || requested === 'shadow') {
      return err(gatewayError('CAPABILITY_ROUTE_DOWNGRADE_DENIED', `能力 ${capability} 为 required，不可降级为 ${requested}`, 'composition.capability.downgradeDenied'));
    }
    return ok('modern');
  }
  if (declared !== undefined) return ok(declared);
  const rank: Record<CapabilityRoute, number> = { legacy: 0, shadow: 1, modern: 2, required: 3 };
  return rank[requested] >= rank[snapshot.root] ? ok(requested) : ok(snapshot.root);
}
