// src/commands/extensionRouting.ts — Wave 3 Plugin/Subagent/MCP 第 1 步：能力组合路由决策
// 与 build/voice/computer 同构 fail-closed：modern/required 请求在生产接线完成前拒绝；
// legacy/shadow 走现有链路。插件（OS 沙箱/权限 broker/签名验证）、子代理（live process host）、
// MCP（extensions 接线 + shutdown 纳入）各自独立接线状态。
import {
  resolveCompositionRouting,
  type CompositionRoutingSnapshot,
} from '../bootstrap/compositionRouting.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

export type ExtensionCapabilityRoute = 'legacy' | 'modern';

export interface ExtensionRouteDecision {
  route: ExtensionCapabilityRoute;
  snapshot: CompositionRoutingSnapshot;
  reason: string;
}

// Plugin 已接线：生产 sandbox + lifecycle（manifest→checksum→probe→沙箱门→owned scope）+ /plugin modern 分支
// （broker 权限请求在生产 ToolExecutionPipeline 接线前 fail-closed——不假执行）
const PLUGIN_WIRED = true;
const SUBAGENT_WIRED = true;
const MCP_WIRED = false;

function decideCapability(input: {
  operatorFlag?: string;
  env?: string;
  capability: string;
  wired: boolean;
  unavailableCode: string;
  unavailableMessage: string;
  unavailableKey: string;
}): OperationResult<ExtensionRouteDecision> {
  const snapshot = resolveCompositionRouting({ operatorFlag: input.operatorFlag, env: input.env });
  if (!snapshot.ok) return snapshot;
  const declared = snapshot.value.capability[input.capability];
  const route: ExtensionCapabilityRoute =
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

export function decidePluginRoute(input: { operatorFlag?: string; env?: string }): OperationResult<ExtensionRouteDecision> {
  return decideCapability({
    ...input,
    capability: 'plugin',
    wired: PLUGIN_WIRED,
    unavailableCode: 'PLUGIN_MODERN_UNAVAILABLE',
    unavailableMessage: 'plugin 能力的 modern 路由不可用',
    unavailableKey: 'plugin.modern.unavailable',
  });
}

export function decideSubagentRoute(input: { operatorFlag?: string; env?: string }): OperationResult<ExtensionRouteDecision> {
  return decideCapability({
    ...input,
    capability: 'subagent',
    wired: SUBAGENT_WIRED,
    unavailableCode: 'SUBAGENT_MODERN_UNAVAILABLE',
    unavailableMessage: 'subagent 能力的 modern 路由不可用',
    unavailableKey: 'subagent.modern.unavailable',
  });
}

export function decideMcpRoute(input: { operatorFlag?: string; env?: string }): OperationResult<ExtensionRouteDecision> {
  return decideCapability({
    ...input,
    capability: 'mcp',
    wired: MCP_WIRED,
    unavailableCode: 'MCP_MODERN_UNAVAILABLE',
    unavailableMessage: 'mcp 能力的 modern 路由尚未完成生产接线（extensions 接线 + shutdown 纳入）',
    unavailableKey: 'mcp.modern.unavailable',
  });
}
