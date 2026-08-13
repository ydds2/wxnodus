// src/domain/mcp/mcpProtocol.ts — Modern MCP 2026-07-28 协议常量与请求元数据（每 request 必带）
export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
export type McpRequestMeta = {
  'io.modelcontextprotocol/protocolVersion': typeof MCP_PROTOCOL_VERSION;
  'io.modelcontextprotocol/clientInfo': { name: string; version: string };
  'io.modelcontextprotocol/clientCapabilities': Record<string, unknown>;
};
export function buildMcpMeta(info: { name: string; version: string }, capabilities: Record<string, unknown>): McpRequestMeta {
  return { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { ...info },
    'io.modelcontextprotocol/clientCapabilities': structuredClone(capabilities) };
}
export function mcpUnavailable(capabilityId: string, surface: 'tools'|'resources'|'prompts'|'notifications'|'elicitation'|'tasks'|'oauth',
  transport: 'stdio'|'streamable-http', reasonCode: 'NOT_DELIVERED'|'TRANSPORT_UNSUPPORTED'|'PEER_DID_NOT_NEGOTIATE'|
  'AUTH_NEGOTIATION_UNAVAILABLE'|'CAPABILITY_UNAVAILABLE'|'POLICY_DENIED'|'CANCELLED') {
  return { status: 'unavailable' as const, capabilityId, surface, transport, reasonCode,
    negotiatedVersion: reasonCode === 'PEER_DID_NOT_NEGOTIATE' ? null : MCP_PROTOCOL_VERSION };
}
