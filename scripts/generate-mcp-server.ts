// scripts/generate-mcp-server.ts — MCP server 显式生成 demo：
// 用法：npm exec -- tsx scripts/generate-mcp-server.ts [serverName] [--out <dir>]
// 产出：<out>/server.ts（可运行 stdio 服务器源码）+ <out>/manifest.json（sha256 绑定）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateMcpServer, type McpToolSignature } from '../src/application/mcp/mcpServerGenerator.js';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? resolve(args[outFlag + 1] ?? '.') : process.cwd();
const serverName = args.filter((arg, index) => arg !== '--out' && index !== outFlag + 1).find(arg => !arg.startsWith('--')) ?? 'wxnodus-demo';

const tools: McpToolSignature[] = [
  { name: 'memory_search', description: 'Search the black-hole long-term memory', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'calc_eval', description: 'Evaluate a deterministic arithmetic expression', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'capability_list', description: 'List declared capabilities', inputSchema: { type: 'object', properties: {} } },
];

const generated = generateMcpServer({ serverName, tools });
if (!generated.ok) {
  process.stderr.write(`MCP_GENERATION_FAILED: ${generated.error.code}\n`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const file of generated.value.files) {
  writeFileSync(join(outDir, file.path), file.content, 'utf8');
  process.stdout.write(`已生成：${join(outDir, file.path)}\n`);
}
process.stdout.write(`${JSON.stringify(generated.value.manifest, null, 2)}\n`);
