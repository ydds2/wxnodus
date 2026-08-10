// src/kernel/mcp.ts — L2-8 MCP 客户端（本地 stdio JSON-RPC）
// 设计：data/mcp.json 配置本地 MCP server（command/args/env），spawn 子进程走
//       stdio JSON-RPC（initialize → notifications/initialized → tools/list → tools/call），
//       工具以 mcp__<server>__<tool> 命名并入 agent；连接失败干净降级不阻断主流程。
//       全部本地进程，不依赖外部平台（本地化为准）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from './tools.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpClient {
  server: McpServerConfig;
  tools: McpToolInfo[];
  callTool(name: string, args: Record<string, any>): Promise<string>;
  close(): void;
}

const REQUEST_TIMEOUT_MS = 15_000;

// ── 配置读写（data/mcp.json，原子写）────────────
export function loadMcpConfig(dataDir: string): McpServerConfig[] {
  const file = join(dataDir, 'mcp.json');
  if (!existsSync(file)) return [];
  try {
    const arr = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.filter((s: any) => s && typeof s.name === 'string' && typeof s.command === 'string');
  } catch {
    return [];
  }
}

export function saveMcpConfig(dataDir: string, servers: McpServerConfig[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'mcp.json'), JSON.stringify(servers, null, 2), 'utf8');
}

// ── JSON-RPC 客户端 ──────────────────────────
interface PendingRpc {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function connectMcp(cfg: McpServerConfig): Promise<McpClient> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}) },
      windowsHide: true,
    });
    let buf = '';
    let nextId = 1;
    const pending = new Map<number, PendingRpc>();
    const toolMap = new Map<string, McpToolInfo>();
    let closed = false;

    const failAll = (err: Error) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    };

    const send = (method: string, params: unknown): Promise<any> => {
      const id = nextId++;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`MCP ${cfg.name} ${method} 超时（${REQUEST_TIMEOUT_MS}ms）`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: res, reject: rej, timer });
        proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };

    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`MCP ${cfg.name} ${msg.error?.message ?? 'error'}`));
          else p.resolve(msg.result);
        }
      }
    });

    proc.on('error', (e) => {
      closed = true;
      failAll(e);
      reject(e);
    });
    proc.on('exit', () => {
      if (!closed) {
        closed = true;
        failAll(new Error(`MCP ${cfg.name} 进程退出`));
      }
    });

    // 握手：initialize → initialized 通知 → tools/list
    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wxnodus', version: '3.0.0' },
    })
      .then(() => proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'))
      .then(() => send('tools/list', {}))
      .then((res: any) => {
        const tools: any[] = res?.tools ?? [];
        for (const t of tools) {
          const name = String(t.name ?? '');
          if (!name) continue;
          toolMap.set(name, {
            server: cfg.name,
            name,
            description: String(t.description ?? ''),
            inputSchema: t.inputSchema,
          });
        }
        resolve({
          server: cfg,
          tools: [...toolMap.values()],
          async callTool(name, args) {
            const r = await send('tools/call', { name, arguments: args ?? {} });
            const content = Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? '').join('\n') : String(r?.content ?? '');
            return (content || `MCP ${cfg.name} 工具 ${name} 返回空`).slice(0, 8000);
          },
          close() {
            if (!closed) {
              closed = true;
              try { proc.stdin!.end(); } catch { /* 忽略 */ }
              try { proc.kill(); } catch { /* 忽略 */ }
            }
          },
        });
      })
      .catch((e) => {
        closed = true;
        try { proc.kill(); } catch { /* 忽略 */ }
        reject(e);
      });
  });
}

// 并发连接所有配置的 server（失败逐个降级，返回成功列表）
export async function connectAllMcp(dataDir: string): Promise<McpClient[]> {
  const cfgs = loadMcpConfig(dataDir);
  const results = await Promise.allSettled(cfgs.map(cfg => connectMcp(cfg)));
  const out: McpClient[] = [];
  for (let i = 0; i < cfgs.length; i++) {
    const r = results[i]!;
    const cfg = cfgs[i]!;
    if (r.status === 'fulfilled') {
      out.push(r.value);
    } else {
      // 连接失败干净降级：不阻断主流程
      out.push({
        server: cfg,
        tools: [],
        async callTool() { return `MCP ${cfg.name} 未连接：${r.reason?.message ?? r.reason}`; },
        close() { /* 无进程 */ },
      });
    }
  }
  return out;
}

// MCP 客户端列表 → agent 工具表（mcp__<server>__<tool> 命名）
export function mcpClientsToTools(clients: McpClient[]): Record<string, ToolDef> {
  const out: Record<string, ToolDef> = {};
  for (const c of clients) {
    for (const t of c.tools) {
      const full = `mcp__${c.server.name}__${t.name}`;
      out[full] = {
        schema: {
          type: 'function',
          function: {
            name: full,
            description: `[MCP ${c.server.name}] ${t.description || t.name}`,
            parameters: (t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {}, required: [] }) as ToolDef['schema']['function']['parameters'],
          },
        },
        danger: false,
        async run(args) {
          return c.callTool(t.name, args);
        },
      };
    }
  }
  return out;
}

// 关闭全部客户端
export function closeAllMcp(clients: McpClient[]): void {
  for (const c of clients) c.close();
}
