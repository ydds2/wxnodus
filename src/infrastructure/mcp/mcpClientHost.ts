// src/infrastructure/mcp/mcpClientHost.ts — modern MCP client host：SDK auto negotiation 是 modern 路径唯一 era 事实源
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCP_PROTOCOL_VERSION } from '../../domain/mcp/mcpProtocol.js';
import { WXNODUS_VERSION } from '../../kernel/version.js';

export type McpClientConfig = { transport: 'stdio'; command: string; args: string[]; env: Record<string,string> } |
  { transport: 'streamable-http'; url: string; headers: Record<string,string> };

export async function connectMcp(config: McpClientConfig, signal: AbortSignal) {
  const client = new Client({ name: 'wxnodus', version: WXNODUS_VERSION }, {
    capabilities: {}, // 此 era ClientCapabilities 为 experimental/extensions 泛形（core 能力由 SDK 注入请求 _meta）
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000, maxRetries: 0 } },
    inputRequired: { autoFulfill: true, maxRounds: 4 },
  });
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
    : new StreamableHTTPClientTransport(new URL(config.url), { protocolVersion: MCP_PROTOCOL_VERSION,
        requestInit: { headers: { ...config.headers } } });
  await client.connect(transport, { signal, timeout: 30_000 });
  const era = client.getProtocolEra();
  const discover = client.getDiscoverResult() ?? (era === 'modern' ? await client.discover({ signal, timeout: 5_000 }) : undefined);
  const negotiatedVersion = client.getNegotiatedProtocolVersion();
  if (era === 'modern' && (!discover || !discover.supportedVersions.includes(MCP_PROTOCOL_VERSION) || negotiatedVersion !== MCP_PROTOCOL_VERSION)) {
    await client.close(); throw Object.assign(new Error('modern discovery mismatch'), { code: 'MCP_PROTOCOL_ERROR' });
  }
  return { client, transport, era, discover, negotiatedVersion, dispose: () => client.close() };
}
