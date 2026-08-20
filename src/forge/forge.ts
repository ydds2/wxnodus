// src/forge/forge.ts — L3-2 组件化构建（forge）
// 设计：工具签名 → 可运行 MCP Server（stdio JSON-RPC，零依赖）+ Skill 打包（agentskills.io 规范）
//       合规红线：产物强制 AI 生成标注（深度合成办法）——README/SKILL.md 必须含标注
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface ToolSignature {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] };
}

// KF-016：目录组合幂等——调用方已按组件名建目录（outDir basename === name）时直接落位该目录，
// 不再二次 join 组件名（路径双拼）；outDir 为父目录时仍创建命名子目录（向后兼容两种调用约定）
const componentDir = (outDir: string, name: string): string => (basename(outDir) === name ? outDir : join(outDir, name));

// 生成可运行 MCP Server（stdio JSON-RPC——@modelcontextprotocol/sdk 协议兼容，零外部依赖）
export function forgeMcpServer(outDir: string, name: string, tools: ToolSignature[]): string {
  const dir = componentDir(outDir, name);
  mkdirSync(dir, { recursive: true });
  const toolList = tools.map(t => `  ${JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema })}`).join(',\n');
  const server = `// ${name} — WxNodus forge 锻造的 MCP Server（stdio JSON-RPC，零依赖）
// AI 生成标注：本文件由 WxNodus 自动生成（深度合成办法 第二十条）
const readline = require('node:readline');
const tools = [
${toolList},
];
const handlers = {
${tools.map(t => `  ${JSON.stringify(t.name)}: (args) => { return { ok: false, error: '占位工具：${t.name} 尚未实现——编辑 server.js 中 handlers['${t.name}'] 填入真实逻辑后使用（严禁伪造成功）' }; }`).join(',\n')}
};
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '${name}', version: '1.0.0' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  if (msg.method === 'tools/call') {
    const h = handlers[msg.params.name];
    if (!h) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'tool not found' } });
    const r = h(msg.params.arguments || {});
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } });
  }
  send({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
});
`;
  writeFileSync(join(dir, 'server.js'), server, 'utf8');
  writeFileSync(join(dir, 'README.md'),
    `# ${name} — MCP Server\n\n由 WxNodus forge 自动生成。\n\n> ⚠️ AI 生成标注（深度合成办法 第二十条）：本组件由 AI 自动生成，使用前请人工复核。\n\n> ⚠️ 占位声明：本产物的工具处理器为占位实现（调用返回诚实错误，不伪造成功）——\n> 编辑 server.js 中 handlers 各条目填入真实逻辑后方可投入使用。\n\n## 工具\n${tools.map(t => `- \`${t.name}\`：${t.description}`).join('\n')}\n`,
    'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'server.js', license: 'Apache-2.0' }, null, 2), 'utf8');
  return dir;
}

// Skill 打包（agentskills.io 规范：SKILL.md + frontmatter）
export function forgeSkillDir(outDir: string, name: string, description: string, workflow: string): string {
  const dir = componentDir(outDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'),
    `---
name: "${name}"
description: "${description}"
ai_generated: true
---

# ${name}

> ⚠️ AI 生成标注（深度合成办法 第二十条）：本技能由 WxNodus 自动提炼生成，启用前请人工确认。

## 工作流

${workflow}
`,
    'utf8');
  return dir;
}
