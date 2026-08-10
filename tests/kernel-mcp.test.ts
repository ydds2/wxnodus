// tests/kernel-mcp.test.ts — L2-8 MCP 客户端：mock stdio server 握手/工具发现/调用/降级
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig, saveMcpConfig, connectMcp, connectAllMcp, mcpClientsToTools, closeAllMcp } from '../src/kernel/mcp.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-mcp-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// mock MCP server：node 子进程实现 stdio JSON-RPC（initialize/tools/list/tools/call）
const MOCK_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0.0' } } }));
  } else if (msg.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'add', description: '加法', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
    ] } }));
  } else if (msg.method === 'tools/call') {
    const args = msg.params.arguments || {};
    let text = 'unknown';
    if (msg.params.name === 'echo') text = 'ECHO:' + args.text;
    if (msg.params.name === 'add') text = 'SUM:' + (Number(args.a) + Number(args.b));
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }));
  }
});
`;

function mockServerArgs(): string[] {
  return ['-e', MOCK_SERVER];
}

describe('MCP 配置读写', () => {
  it('loadMcpConfig 空文件返回空数组', () => {
    expect(loadMcpConfig(dir)).toEqual([]);
  });
  it('saveMcpConfig 原子写并可读回', () => {
    saveMcpConfig(dir, [{ name: 'demo', command: 'node', args: ['-e', 'x'] }]);
    const loaded = loadMcpConfig(dir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.name).toBe('demo');
    expect(loaded[0]!.command).toBe('node');
  });
  it('非法配置被过滤', () => {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify([{ name: 'no-cmd' }, 'junk', { name: 'ok', command: 'node' }]));
    expect(loadMcpConfig(dir).map(s => s.name)).toEqual(['ok']);
  });
});

describe('connectMcp 握手与工具发现', () => {
  it('initialize → tools/list 返回工具表', async () => {
    const client = await connectMcp({ name: 'mock', command: process.execPath, args: mockServerArgs() });
    expect(client.tools.map(t => t.name).sort()).toEqual(['add', 'echo']);
    expect(client.tools[0]!.server).toBe('mock');
    client.close();
  });
  it('tools/call 真实调用并返回文本', async () => {
    const client = await connectMcp({ name: 'mock', command: process.execPath, args: mockServerArgs() });
    expect(await client.callTool('echo', { text: '你好' })).toBe('ECHO:你好');
    expect(await client.callTool('add', { a: 2, b: 3 })).toBe('SUM:5');
    client.close();
  });
  it('连接失败（不存在的命令）抛错', async () => {
    await expect(connectMcp({ name: 'bad', command: 'no-such-cmd-xyz', args: [] })).rejects.toThrow();
  });
});

describe('mcpClientsToTools 并入 agent 工具表', () => {
  it('命名 mcp__<server>__<tool> 且 schema 完整', async () => {
    const clients = await connectAllMcp(dir); // 无配置：空
    expect(clients).toEqual([]);
    saveMcpConfig(dir, [{ name: 'mock', command: process.execPath, args: mockServerArgs() }]);
    const connected = await connectAllMcp(dir);
    expect(connected.length).toBe(1);
    const tools = mcpClientsToTools(connected);
    expect(Object.keys(tools).sort()).toEqual(['mcp__mock__add', 'mcp__mock__echo']);
    expect(await tools['mcp__mock__echo']!.run({ text: 'hi' }, { cwd: dir, dataDir: dir })).toContain('ECHO:hi');
    closeAllMcp(connected);
  });
  it('连接失败的 server 降级为无工具（不阻断）', async () => {
    saveMcpConfig(dir, [{ name: 'broken', command: 'no-such-cmd-xyz' }]);
    const clients = await connectAllMcp(dir);
    expect(clients.length).toBe(1);
    expect(clients[0]!.tools).toEqual([]);
    const tools = mcpClientsToTools(clients);
    expect(Object.keys(tools)).toEqual([]);
    closeAllMcp(clients);
  });
});

// ── P3b：工具命名与调用链路 / 失败降级 ──
describe('MCP 工具链路', () => {
  it('工具命名为 mcp__server__tool 且可调用', async () => {
    const cfg: any = { name: 'mock', command: 'node', args: mockServerArgs() };
    const client = await connectMcp(cfg);
    const tools = mcpClientsToTools([client]);
    const names = Object.keys(tools);
    expect(names).toContain('mcp__mock__echo');
    expect(names).toContain('mcp__mock__add');
    const addTool = tools['mcp__mock__add']!;
    expect(addTool.danger).toBe(false); // MCP 工具默认非危险标记
    const out = await addTool.run({ a: 2, b: 3 }, { cwd: process.cwd(), dataDir: dir });
    expect(String(out)).toContain('SUM:5');
    const echoOut = await tools['mcp__mock__echo']!.run({ text: 'hi' }, { cwd: process.cwd(), dataDir: dir });
    expect(String(echoOut)).toContain('ECHO:hi');
    closeAllMcp([client]);
  });
  it('连接失败返回 null（降级不抛）', async () => {
    const bad: any = { name: 'ghost', command: 'node', args: ['-e', 'process.exit(1)'] };
    await expect(connectMcp(bad)).rejects.toThrow();
  });
  it('connectAllMcp 空配置返回空数组', async () => {
    expect(await connectAllMcp(dir)).toEqual([]);
  });
  it('closeAllMcp 幂等', async () => {
    closeAllMcp([]);
    const cfg: any = { name: 'mock', command: 'node', args: mockServerArgs() };
    const client = await connectMcp(cfg);
    closeAllMcp([client]);
    closeAllMcp([client]);
  });
  it('连接超时快速失败（15s 内）', async () => {
    const t0 = Date.now();
    const sleeper: any = { name: 'sleeper', command: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'] };
    await expect(connectMcp(sleeper)).rejects.toThrow(/超时/);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });
});
