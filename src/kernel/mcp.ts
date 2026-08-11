// src/kernel/mcp.ts — L2-8 MCP 客户端（本地 stdio JSON-RPC）
// 设计：MCP 配置两级（生态对齐 Claude Code .mcp.json）：
//       项目级 <cwd>/.mcp.json（mcpServers 对象或数组两种格式）→ 用户级 data/mcp.json；
//       strict 模式仅信任项目声明（--strict-mcp-config 等价）；项目同名覆盖用户。
//       spawn 子进程走 stdio JSON-RPC（initialize → notifications/initialized →
//       tools/list → tools/call），工具以 mcp__<server>__<tool> 命名并入 agent；
//       连接失败干净降级不阻断主流程。全部本地进程，不依赖外部平台（本地化为准）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from './tools.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 启动/请求超时（ms，Codex startup_timeout_ms 对齐；缺省 15s） */
  startupTimeoutMs?: number;
}

/** 带来源标注的配置项（/mcp list 展示 [项目]/[用户]） */
export interface McpConfigEntry extends McpServerConfig {
  source: 'project' | 'user';
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
export const PROJECT_MCP_FILE = '.mcp.json';

// ── 配置读取（两级：项目 .mcp.json + 用户 data/mcp.json）────────
function parseServerList(raw: string): McpServerConfig[] {
  try {
    const j = JSON.parse(raw);
    // 格式一：{ "mcpServers": { "name": { command, args, env } } }（Claude Code 生态标准）
    if (j && typeof j === 'object' && !Array.isArray(j) && j.mcpServers && typeof j.mcpServers === 'object') {
      return Object.entries(j.mcpServers as Record<string, any>).map(([name, s]) => ({
        name, command: String(s?.command ?? ''), args: Array.isArray(s?.args) ? s.args.map(String) : [], env: s?.env,
      })).filter(s => s.command);
    }
    // 格式二：数组 [{ name, command, args, env }]（wxnodus 原生）
    if (Array.isArray(j)) {
      return j.filter((s: any) => s && typeof s.name === 'string' && typeof s.command === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/** 项目级配置：<cwd>/.mcp.json（优先，支持两种格式） */
export function loadProjectMcpConfig(cwd: string): McpServerConfig[] {
  const file = join(cwd, PROJECT_MCP_FILE);
  if (!existsSync(file)) return [];
  return parseServerList(readFileSync(file, 'utf8'));
}

/** 用户级配置：data/mcp.json（数组格式） */
export function loadUserMcpConfig(dataDir: string): McpServerConfig[] {
  const file = join(dataDir, 'mcp.json');
  if (!existsSync(file)) return [];
  return parseServerList(readFileSync(file, 'utf8'));
}

/**
 * 合并加载 MCP 配置。
 * @param dataDir 用户数据目录
 * @param opts.cwd 项目根（提供则读取 .mcp.json；项目同名覆盖用户）
 * @param opts.strict 仅信任项目声明（strictMcpConfig 设置 / --strict-mcp-config）
 */
export function loadMcpConfig(dataDir: string, opts: { cwd?: string; strict?: boolean } = {}): McpConfigEntry[] {
  const entries: McpConfigEntry[] = [];
  const project = opts.cwd ? loadProjectMcpConfig(opts.cwd) : [];
  for (const s of project) entries.push({ ...s, source: 'project' });
  if (!opts.strict) {
    const user = loadUserMcpConfig(dataDir);
    const projNames = new Set(project.map(s => s.name));
    for (const s of user) {
      if (projNames.has(s.name)) continue; // 项目同名覆盖用户
      entries.push({ ...s, source: 'user' });
    }
  }
  return entries;
}

/** 写入项目级 .mcp.json（Claude Code 兼容 mcpServers 对象格式） */
export function saveProjectMcpConfig(cwd: string, servers: McpServerConfig[]): void {
  const obj: Record<string, any> = {};
  for (const s of servers) obj[s.name] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
  writeFileSync(join(cwd, PROJECT_MCP_FILE), JSON.stringify({ mcpServers: obj }, null, 2), 'utf8');
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
        const timeoutMs = cfg.startupTimeoutMs && cfg.startupTimeoutMs > 0 ? cfg.startupTimeoutMs : REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`MCP ${cfg.name} ${method} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
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
export async function connectAllMcp(dataDir: string, opts: { cwd?: string; strict?: boolean } = {}): Promise<McpClient[]> {
  const cfgs = loadMcpConfig(dataDir, opts);
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
