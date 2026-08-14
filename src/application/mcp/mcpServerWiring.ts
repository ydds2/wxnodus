// src/application/mcp/mcpServerWiring.ts — W3 MCP facade：incoming server 生产接线（stdio + Streamable HTTP）
// 端口全部真实：CapabilityPort（registry.require 决定 surface 可用性）、fail-closed pipeline
// （生产 ToolExecutionPipeline 未接线前一律结构化 NOT_DELIVERED——绝不假发布）、transcript、contextFactory。
// 两种传输真实启动（stdio connect / HTTP toNodeHandler）；close() 由调用方纳入统一 shutdown。
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CapabilityPort } from '../../domain/capabilities/capability.js';
import { mcpUnavailable } from '../../domain/mcp/mcpProtocol.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { InMemoryMcpTranscriptStore } from '../../infrastructure/mcp/mcpTranscriptStore.js';
import { createRegisteredServer, createWxNodusHttpHandler, type WxNodusMcpPorts } from '../../infrastructure/mcp/wxnodusMcpServer.js';

export interface McpIncomingServerOptions {
  capabilities: CapabilityPort;
  contextFactory(): OperationContext;
  clock?(): string;
}

export interface McpIncomingServer {
  /** Streamable HTTP：Node (req,res) handler（挂载点仍需 Bearer/CSRF 前置——见 serve 路由链） */
  httpHandler(req: unknown, res: unknown): Promise<void>;
  /** stdio：真实启动（connect StdioServerTransport）——requestState 密钥缺失时 fail-closed */
  startStdio(): Promise<void>;
  /** 统一 shutdown 用：stdio 已连接时 close；HTTP handler 无独立连接状态 */
  close(): Promise<void>;
}

/** requestState 密钥：≥256-bit（base64 编码后 ≥32 字节）——生产由环境注入；缺失即不可安全启动 */
export const hasRequestStateKey = (): boolean =>
  Buffer.from(process.env.WXNODUS_MCP_REQUEST_STATE_KEY ?? '', 'base64').length >= 32;

export function createMcpIncomingServer(options: McpIncomingServerOptions): McpIncomingServer {
  const transcript = new InMemoryMcpTranscriptStore(options.clock ?? (() => new Date().toISOString()));
  // fail-closed pipeline：生产 ToolExecutionPipeline（W1-08 11 ports，前置 plugin broker）未接线前，
  // 任何通过 capabilities.require() 的 surface 调用一律结构化 NOT_DELIVERED——绝不假发布。
  const failClosedPipeline = {
    async execute(request: { toolId: string }) {
      return mcpUnavailable(request.toolId, 'tools', 'stdio', 'NOT_DELIVERED');
    },
  } as never;
  const ports: WxNodusMcpPorts = {
    capabilities: options.capabilities,
    pipeline: failClosedPipeline,
    transcript,
    contextFactory: options.contextFactory,
  };
  const ready = hasRequestStateKey();
  let connected = false;
  let registered: ReturnType<typeof createRegisteredServer> | null = null;
  let nodeHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;

  return {
    async httpHandler(req, res) {
      if (!ready) {
        const body = JSON.stringify({ ok: false, error: { code: 'MCP_REQUEST_STATE_KEY_MISSING' } });
        (res as { writeHead(c: number, h: Record<string, string>): void; end(b: string): void })
          .writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        (res as { end(b: string): void }).end(body);
        return;
      }
      if (!nodeHandler) {
        nodeHandler = toNodeHandler(createWxNodusHttpHandler(ports).handler) as never;
      }
      await nodeHandler(req, res);
    },
    async startStdio() {
      if (!ready) {
        throw Object.assign(
          new Error('WXNODUS_MCP_REQUEST_STATE_KEY must be at least 256 bits (base64)'),
          { code: 'MCP_REQUEST_STATE_KEY_MISSING' },
        );
      }
      registered = createRegisteredServer(ports);
      await registered.server.connect(registered.stdio());
      connected = true;
    },
    async close() {
      if (connected && registered) await registered.server.close();
    },
  };
}
