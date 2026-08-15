// scripts/evidence-mcp-e2e.ts — W8-05：MCP 真实端到端证据（tsx 实跑）
// 流程（全真实，零 mock）：generateMcpServer 真实生成可运行 stdio 服务器 → 落盘证据工作区 →
// 生产客户端 connectAllMcp 真实 spawn 连接（握手 initialize/tools-list）→ callTool 真实
// tools/call → mcpClientsToTools 真实工具表映射（mcp__<server>__<tool>）→ closeAllMcp 清理。
// receipt 落 artifacts/release-evidence/<runId>/mcp-e2e/outcome.json；任一断言失败 exit 2。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runId = flag('run');
if (!runId) {
  console.error('EVIDENCE_USAGE: --run <runId>');
  process.exit(2);
}

const workdir = join(ROOT, 'artifacts', 'release-evidence', runId, 'mcp-e2e');
const dataDir = join(workdir, 'data');
mkdirSync(dataDir, { recursive: true });

// 1. 真实生成器产出可运行 stdio 服务器（签名面声明 + 回显 handler——生成物语义如实在 receipt 声明）
const { generateMcpServer } = await import('../src/application/mcp/mcpServerGenerator.js');
const tools = [
  { name: 'memory_search', description: 'Search the black-hole long-term memory', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'calc_eval', description: 'Evaluate a deterministic arithmetic expression', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'capability_list', description: 'List declared capabilities', inputSchema: { type: 'object', properties: {} } },
];
const generated = generateMcpServer({ serverName: 'wxnodus-demo', tools });
if (!generated.ok) {
  console.error(JSON.stringify({ status: 'failed', step: 'generate', error: generated.error.code }));
  process.exit(2);
}
for (const file of generated.value.files) {
  writeFileSync(join(workdir, file.path), file.content, 'utf8');
}
const serverPath = join(workdir, 'server.ts');
const manifest = generated.value.manifest;

// 2. 项目级 .mcp.json（Claude Code 兼容 mcpServers 格式）→ 生产客户端加载
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
writeFileSync(join(workdir, '.mcp.json'), JSON.stringify({
  mcpServers: {
    demo: { command: process.execPath, args: [tsxCli, serverPath] },
  },
}, null, 2), 'utf8');

// 3. 生产模块真实连接（spawn 真进程 + 握手 + tools/list）
const { connectAllMcp, mcpClientsToTools, closeAllMcp } = await import('../src/kernel/mcp.js');
const t0 = Date.now();
const clients = await connectAllMcp(dataDir, { cwd: workdir });
const connectMs = Date.now() - t0;

const client = clients[0];
const names = (client?.tools ?? []).map(t => t.name).sort();
const connected = client?.connected === true;

// 4. 真实工具调用（tools/call 往返真实服务器进程）
let toolResult = '';
let toolCallError = '';
try {
  toolResult = client ? await client.callTool('calc_eval', { expression: '2+3*4' }) : '';
} catch (e: any) {
  toolCallError = String(e?.message ?? e);
}

// 5. 工具表映射（agent extraTools 命名 mcp__<server>__<tool>）
const table = mcpClientsToTools(clients);
const tableKeys = Object.keys(table).sort();

const checks = {
  generated: generated.ok,
  connected,
  toolsListed: names.join(',') === 'calc_eval,capability_list,memory_search',
  toolCallOk: toolResult.length > 0 && toolCallError === '',
  tableMapped: tableKeys.join(',') === 'mcp__demo__calc_eval,mcp__demo__capability_list,mcp__demo__memory_search',
  tableSchemaIntact: Boolean(table['mcp__demo__calc_eval']?.schema),
};
const passed = Object.values(checks).every(Boolean);

closeAllMcp(clients); // 清理：关闭真实子进程

const outcome = {
  schema: 'mcp-e2e-evidence@1',
  runId,
  timestamp: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}/node${process.version}`,
  server: {
    path: serverPath,
    manifestSha256: manifest?.sha256 ?? null,
    handlerSemantics: '签名面声明 + 回显（生成物不伪造未实现业务逻辑）',
  },
  config: { projectMcpJson: join(workdir, '.mcp.json'), transport: 'stdio' },
  connect: { clients: clients.length, connected, tools: names, connectMs },
  toolCall: { name: 'calc_eval', args: { expression: '2+3*4' }, result: toolResult.slice(0, 400), error: toolCallError },
  toolTable: tableKeys,
  cleanup: 'closeAllMcp',
  checks,
  status: passed ? 'passed' : 'failed',
  verdict: passed
    ? 'MCP 真实端到端成立：生成 → 生产客户端 stdio 连接 → 真实 tools/call 往返 → agent 工具表映射——全部真实进程证据'
    : 'MCP E2E 未达标——如实 blocked',
};
writeFileSync(join(workdir, 'outcome.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify({ status: outcome.status, connected, tools: names, toolResult: toolResult.slice(0, 120), tableKeys, connectMs, receipt: join(workdir, 'outcome.json') }, null, 2));
// 服务器进程退出确认（stdin 关闭 → 进程应退出；此处仅记录，不阻塞）
process.exit(passed ? 0 : 2);
