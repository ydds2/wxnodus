// src/domain/tools/toolIds.ts — 命名空间化 ToolId 解析
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

export const TOOL_NAMESPACES = ['builtin', 'mcp', 'plugin', 'skill', 'forge', 'agent'] as const;
export type ToolNamespace = (typeof TOOL_NAMESPACES)[number];
export type ToolId = `${ToolNamespace}:${string}` & { readonly __brand: 'ToolId' };

const LOCAL = /^[a-z0-9][a-z0-9._-]*$/;

export function parseToolId(raw: string) {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) {
    return err(gatewayError('TOOL_ID_INVALID', `无效 ToolId：${raw}`, 'tool.id.invalid'));
  }
  const namespace = raw.slice(0, colon);
  const local = raw.slice(colon + 1);
  if (!(TOOL_NAMESPACES as readonly string[]).includes(namespace)) {
    return err(gatewayError('TOOL_NAMESPACE_UNSUPPORTED', `不支持的 tool namespace：${namespace}`, 'tool.namespace.unsupported'));
  }
  if (!LOCAL.test(local)) {
    return err(gatewayError('TOOL_ID_INVALID', `无效 ToolId local name：${local}`, 'tool.id.invalid'));
  }
  return ok(raw as ToolId);
}

export function localToolName(id: ToolId): string {
  return id.slice(id.indexOf(':') + 1);
}
