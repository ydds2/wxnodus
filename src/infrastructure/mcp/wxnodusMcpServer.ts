// src/infrastructure/mcp/wxnodusMcpServer.ts — WxNodus MCP Server：modern 2026-07-28 双工（discover/tools/resources/prompts/elicitation）
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { InMemoryServerEventBus, McpServer, acceptedContent, createMcpHandler, inputRequired,
  specTypeSchemas, type DiscoverResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { CapabilityPort } from '../../domain/capabilities/capability.js';
import type { ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err } from '../../protocol/results.js';
import { MCP_PROTOCOL_VERSION, mcpUnavailable, type McpRequestMeta } from '../../domain/mcp/mcpProtocol.js';
import type { InMemoryMcpTranscriptStore } from './mcpTranscriptStore.js';

const future = (id: 'build'|'verify'|'evidence'|'browser'|'computer'|'forge') => ({ id, delivered: false as const,
  stableStatus: 'NOT_DELIVERED' as const, reasonCode: 'NOT_DELIVERED' as const });
export const WXNODUS_MCP_SURFACES = Object.freeze([
  { id: 'session', delivered: true, stableStatus: 'DELIVERED' },
  { id: 'memory', delivered: true, stableStatus: 'DELIVERED' },
  future('build'), future('verify'), future('evidence'), future('browser'), future('computer'), future('forge'),
] as const);
const capabilities = { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true },
  prompts: { listChanged: true }, subscriptions: {}, elicitation: { form: {} } } as const;

export interface WxNodusMcpPorts { capabilities: CapabilityPort; pipeline: ToolExecutionPipeline;
  transcript: InMemoryMcpTranscriptStore; contextFactory(): OperationContext; tasksPreview?: false }

export class WxNodusMcpAdapter {
  static readonly releaseContract = { tasks: 'disabled', gaDependencies: [] as string[] } as const;
  constructor(private readonly ports: WxNodusMcpPorts) {}
  discovery(): DiscoverResult {
    const candidate = { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities,
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'wxnodus', version: '4.0.0' } } };
    const validated = specTypeSchemas.DiscoverResult['~standard'].validate(candidate);
    if (validated.issues) throw Object.assign(new Error('invalid SDK discover DTO'), { code: 'MCP_PROTOCOL_ERROR' });
    return validated.value;
  }
  async call(id: typeof WXNODUS_MCP_SURFACES[number]['id'], args: Record<string, unknown>, meta: McpRequestMeta,
    context: OperationContext, signal: AbortSignal) {
    const requestId = randomUUID();
    const record = (status: 'ok'|'denied'|'cancelled'|'error') => this.ports.transcript.append({ requestId,
      direction: 'in', method: `tools/call:${id}`, status, payload: args, evidenceId: `mcp:${requestId}` });
    if (signal.aborted) { record('cancelled'); return mcpUnavailable(id, 'tools', 'stdio', 'CANCELLED'); }
    if (meta['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_VERSION) { record('denied');
      return err(gatewayError('MCP_PROTOCOL_ERROR', id, 'mcp.protocol.invalid')); }
    if (args._meta && Object.keys(args._meta as object).some(key => ['actorId','sessionId','runId','capabilities','grant','budget','ownedFiles'].includes(key))) {
      record('denied'); return err(gatewayError('MCP_CONTEXT_OVERRIDE_FORBIDDEN', id, 'mcp.context.override'));
    }
    const surface = WXNODUS_MCP_SURFACES.find(item => item.id === id)!;
    if (!surface.delivered) { record('denied'); return mcpUnavailable(id, 'tools', 'stdio', 'NOT_DELIVERED'); }
    const capability = this.ports.capabilities.require(id); if (!capability.ok) { record('denied');
      return mcpUnavailable(id, 'tools', 'stdio', 'CAPABILITY_UNAVAILABLE'); }
    const result = await this.ports.pipeline.execute({ id: requestId, toolId: `builtin:${id}`, args } as never, context, signal);
    record(result.ok ? 'ok' : signal.aborted ? 'cancelled' : 'denied'); return result;
  }
}

export function createRegisteredServer(ports: WxNodusMcpPorts) {
  const adapter = new WxNodusMcpAdapter(ports);
  const requestStateKey = Buffer.from(process.env.WXNODUS_MCP_REQUEST_STATE_KEY ?? '', 'base64');
  if (requestStateKey.length < 32) throw new Error('WXNODUS_MCP_REQUEST_STATE_KEY must be at least 256 bits');
  const verifyState = (state: string) => { const [payload, mac] = state.split('.');
    if (!payload || !mac) throw new Error('invalid requestState');
    const expected = createHmac('sha256', requestStateKey).update(payload).digest(); const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid requestState');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown; };
  const server = new McpServer({ name: 'wxnodus', version: '4.0.0' }, { capabilities,
    cacheHints: { 'server/discover': { ttlMs: 0, cacheScope: 'private' }, 'tools/list': { ttlMs: 0, cacheScope: 'private' },
      'resources/list': { ttlMs: 0, cacheScope: 'private' }, 'resources/templates/list': { ttlMs: 0, cacheScope: 'private' },
      'resources/read': { ttlMs: 0, cacheScope: 'private' }, 'prompts/list': { ttlMs: 0, cacheScope: 'private' } },
    inputRequired: { maxRounds: 4, roundTimeoutMs: 120_000, legacyShim: false },
    requestState: { verify: verifyState } });
  server.server.registerCapabilities(capabilities); // SDK owns/validates `server/discover` 与 `supportedVersions`
  for (const surface of WXNODUS_MCP_SURFACES) server.registerTool(surface.id,
    { description: surface.stableStatus },
    async ctx => {
      if (surface.id === 'session' && !acceptedContent(ctx.mcpReq.inputResponses, 'confirm')) {
        return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: 'Continue session operation?',
          requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } }) } });
      }
      const result: unknown = await adapter.call(surface.id, {}, ctx.mcpReq.envelope as McpRequestMeta,
        ports.contextFactory(), ctx.mcpReq.signal);
      // SDK ToolCallback 需要 CallToolResult 形状：unavailable/error 也结构化为 content（绝不抛假成功）
      if (typeof result === 'object' && result !== null && 'status' in result && (result as { status?: unknown }).status === 'unavailable') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as never };
      }
      if (typeof result === 'object' && result !== null && 'ok' in result && (result as { ok?: unknown }).ok === false) {
        const code = ((result as { error?: { code?: string } }).error?.code) ?? 'MCP_TOOL_DENIED';
        return { content: [{ type: 'text' as const, text: JSON.stringify({ code }) }], structuredContent: { code } };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as never };
    });
  server.registerResource('capabilities', 'wxnodus://capabilities', { mimeType: 'application/json',
    cacheHint: { ttlMs: 0, cacheScope: 'private' } }, async uri => ({ contents: [{ uri: uri.href,
      mimeType: 'application/json', text: JSON.stringify(WXNODUS_MCP_SURFACES) }], ttlMs: 0, cacheScope: 'private' }));
  server.registerPrompt('session-summary', { description: 'Summarize a delivered session' }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this session.' } }] }));
  const registrations = ['server/discover','tools','resources','prompts','subscriptions/listen','elicitation/form'] as const;
  return { server, registrations, discovery: () => adapter.discovery(), stdio: () => new StdioServerTransport() };
}

export function createWxNodusHttpHandler(ports: WxNodusMcpPorts) {
  const bus = new InMemoryServerEventBus();
  const handler = createMcpHandler(() => createRegisteredServer(ports).server, { bus, responseMode: 'auto', maxSubscriptions: 128 });
  return { handler, bus, notify: handler.notify }; // notify 发布 tools/prompts/resources list 与 resource-updated 事件
}
