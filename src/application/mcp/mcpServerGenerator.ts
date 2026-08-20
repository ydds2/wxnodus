// src/application/mcp/mcpServerGenerator.ts — MCP Server 显式生成：工具签名 → 可运行 stdio 服务器源码 + 绑定 manifest
// （生成产物只声明签名面并回显声明，业务 handler 注入留给运行时——绝不伪造未实现的业务逻辑）
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export interface McpToolSignature {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerGeneration {
  manifest: {
    schemaVersion: 1;
    serverName: string;
    protocolVersion: string;
    tools: string[];
    /** canonical 绑定 source 全部字节 + manifest 元数据 */
    sha256: string;
  };
  files: Array<{ path: string; content: string }>;
}

const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

const fail = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: configError(code, `mcp.generate.${code.toLowerCase()}`, details),
});

export function generateMcpServer(input: { serverName: string; protocolVersion?: string; tools: McpToolSignature[] }): OperationResult<McpServerGeneration> {
  if (!TOOL_NAME.test(input.serverName)) return fail('MCP_GENERATE_INVALID_NAME', { serverName: input.serverName });
  if (input.tools.length === 0) return fail('MCP_GENERATE_NO_TOOLS');
  for (const tool of input.tools) {
    if (!TOOL_NAME.test(tool.name)) return fail('MCP_GENERATE_INVALID_TOOL', { tool: tool.name });
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1024) {
      return fail('MCP_GENERATE_INVALID_TOOL', { tool: tool.name, reason: 'description' });
    }
    if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema)) {
      return fail('MCP_GENERATE_INVALID_TOOL', { tool: tool.name, reason: 'inputSchema' });
    }
  }
  const protocolVersion = input.protocolVersion ?? '2026-07-28';
  const toolLines = input.tools.map(tool => `    '${tool.name}',`).join('\n');
  const toolDeclarations = input.tools.map(tool => `  server.registerTool('${tool.name}', { description: ${JSON.stringify(tool.description)}, inputSchema: fromJsonSchema(${JSON.stringify(tool.inputSchema)} as any) }, async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: '占位工具：${tool.name} 尚未实现——运行时注入业务 handler 前调用即失败（严禁伪造成功）' }) }] }));`).join('\n');
  const source = `// ${input.serverName} — generated MCP server（stdio 零依赖，签名面声明 + 诚实失败）
// 生成物只声明工具签名面；业务 handler 由运行时注入（不伪造未实现的业务逻辑——默认 handler 如实报错）
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: ${JSON.stringify(input.serverName)}, version: '1.0.0' });
${toolDeclarations}
await server.connect(new StdioServerTransport());
export const declaredTools = [
${toolLines}
] as const;
`;
  const manifest: McpServerGeneration['manifest'] = {
    schemaVersion: 1,
    serverName: input.serverName,
    protocolVersion,
    tools: input.tools.map(tool => tool.name),
    sha256: '',
  };
  const files = [
    { path: 'server.ts', content: source },
    { path: 'manifest.json', content: '' },
  ];
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  manifest.sha256 = createHash('sha256').update(`${JSON.stringify({ ...manifest, sha256: undefined })}${sourceDigest}`).digest('hex');
  files[1] = { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` };
  return { ok: true, value: { manifest, files } };
}
