// src/kernel/mcp.ts — L2-8 MCP 客户端（本地 stdio JSON-RPC）
// 设计：MCP 配置两级（生态对齐 Claude Code .mcp.json）：
//       项目级 <cwd>/.mcp.json（mcpServers 对象或数组两种格式）→ 用户级 data/mcp.json；
//       strict 模式仅信任项目声明（--strict-mcp-config 等价）；项目同名覆盖用户。
//       spawn 子进程走 stdio JSON-RPC（initialize → notifications/initialized →
//       tools/list → tools/call），工具以 mcp__<server>__<tool> 命名并入 agent；
//       连接失败干净降级不阻断主流程。全部本地进程，不依赖外部平台（本地化为准）。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolDef } from './tools.js';
import { sanitizedEnv } from './env.js';
import { WXNODUS_VERSION } from './version.js';
import { authorizeOutboundUrl } from '../infrastructure/http/outboundTargetPolicy.js';
import { terminateProcessTree } from '../infrastructure/process/processSupervisor.js';

interface McpServerConfigBase {
  name: string;
  /** 启动握手超时（ms，缺省 15s） */
  startupTimeoutMs?: number;
  /** 常规工具请求超时（ms） */
  timeoutMs?: number;
  /** 工具级危险声明：{ <toolName>: true } 的 MCP 工具走确认门。 */
  toolDanger?: Record<string, boolean>;
}

export interface McpServerConfig extends McpServerConfigBase {
  /** stdio executable; legacy HTTP callers use an empty string sentinel. */
  command: string;
  /** Streamable HTTP endpoint. Runtime validation makes this exclusive with a non-empty command. */
  url?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpStdioServerConfig extends McpServerConfig {
  command: string;
  url?: undefined;
}

export interface McpHttpServerConfig extends McpServerConfig {
  command: '';
  url: string;
}

type ValidatedMcpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** 带来源标注的配置项（/mcp list 展示 [项目]/[用户]） */
export type McpConfigEntry = McpServerConfig & { source: 'project' | 'user' };

export class McpConfigError extends Error {
  readonly code = 'MCP_CONFIG_INVALID' as const;

  constructor(readonly file: string, message: string, options?: ErrorOptions) {
    super(`MCP 配置 ${file} 无效：${message}`, options);
    this.name = 'McpConfigError';
  }
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
  /** 连接状态（connectAllMcp 失败降级时 false——真实状态，UI 状态栏可读） */
  connected: boolean;
  callTool(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string>;
  close(): void | Promise<void>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 1_000;
const MIN_STARTUP_HANDSHAKE_MS = 250;
const STDERR_TAIL_CHARS = 2_048;
const HTTP_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const PROJECT_MCP_FILE = '.mcp.json';
const MCP_TRUST_FILE = '.wxnodus-mcp-trust.json';

function mcpTrustKey(cwd: string, server: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify({
    workspace: resolve(cwd),
    name: server.name,
    command: server.command,
    url: server.url ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    startupTimeoutMs: server.startupTimeoutMs ?? null,
    timeoutMs: server.timeoutMs ?? null,
    toolDanger: server.toolDanger ?? {},
  })).digest('hex');
}

export function loadProjectMcpTrust(dataDir: string): Record<string, true> {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, MCP_TRUST_FILE), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([digest, trusted]) => /^[a-f0-9]{64}$/.test(digest) && trusted === true)) as Record<string, true>;
  } catch { return {}; }
}

export function trustProjectMcpServer(dataDir: string, cwd: string, server: McpServerConfig): void {
  const file = join(dataDir, MCP_TRUST_FILE);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...loadProjectMcpTrust(dataDir), [mcpTrustKey(cwd, server)]: true }, null, 2) + '\n', 'utf8');
}

export function isProjectMcpTrusted(dataDir: string, cwd: string, server: McpServerConfig): boolean {
  return loadProjectMcpTrust(dataDir)[mcpTrustKey(cwd, server)] === true;
}

// ── 配置读取（两级：项目 .mcp.json + 用户 data/mcp.json）────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configFailure(file: string, path: string, message: string): never {
  throw new McpConfigError(file, `${path} ${message}`);
}

function optionalPositiveNumber(source: Record<string, unknown>, key: 'startupTimeoutMs' | 'timeoutMs', file: string, path: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    configFailure(file, `${path}.${key}`, '必须是正数');
  }
  return value;
}

function optionalStringArray(value: unknown, file: string, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    configFailure(file, path, '必须是字符串数组');
  }
  return [...value];
}

function optionalStringMap(value: unknown, file: string, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'string')) {
    configFailure(file, path, '必须是字符串映射');
  }
  return { ...value } as Record<string, string>;
}

function optionalBooleanMap(value: unknown, file: string, path: string): Record<string, boolean> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'boolean')) {
    configFailure(file, path, '必须是布尔值映射');
  }
  return { ...value } as Record<string, boolean>;
}

function parseServer(value: unknown, nameHint: string | undefined, file: string, path: string): ValidatedMcpServerConfig {
  if (!isRecord(value)) configFailure(file, path, '必须是对象');
  const nameValue = nameHint ?? value.name;
  if (typeof nameValue !== 'string' || !nameValue.trim()) configFailure(file, `${path}.name`, '必须是非空字符串');

  const command = typeof value.command === 'string' && value.command.trim() ? value.command : undefined;
  const url = typeof value.url === 'string' && value.url.trim() ? value.url : undefined;
  if (value.command !== undefined && typeof value.command !== 'string') configFailure(file, `${path}.command`, '必须是字符串');
  if (value.url !== undefined && typeof value.url !== 'string') configFailure(file, `${path}.url`, '必须是字符串');
  if ((command && url) || (!command && !url)) configFailure(file, path, '必须且只能配置 command 或 url');

  const startupTimeoutMs = optionalPositiveNumber(value, 'startupTimeoutMs', file, path);
  const timeoutMs = optionalPositiveNumber(value, 'timeoutMs', file, path);
  const toolDanger = optionalBooleanMap(value.toolDanger, file, `${path}.toolDanger`);
  const common = {
    name: nameValue,
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(toolDanger ? { toolDanger } : {}),
  };

  if (url) {
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch (cause) { configFailure(file, `${path}.url`, `不是有效 URL：${String(cause)}`); }
    if (parsedUrl!.protocol !== 'http:' && parsedUrl!.protocol !== 'https:') configFailure(file, `${path}.url`, '仅支持 http/https');
    const args = optionalStringArray(value.args, file, `${path}.args`);
    const env = optionalStringMap(value.env, file, `${path}.env`);
    if ((args?.length ?? 0) > 0 || (env && Object.keys(env).length > 0)) {
      configFailure(file, path, 'HTTP 配置不能包含非空 args 或 env');
    }
    return { ...common, command: '', url };
  }

  const args = optionalStringArray(value.args, file, `${path}.args`);
  const env = optionalStringMap(value.env, file, `${path}.env`);
  return { ...common, command: command!, ...(args ? { args } : {}), ...(env ? { env } : {}) };
}

function parseServerList(raw: string, file = 'MCP config'): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new McpConfigError(file, `JSON 解析失败：${String((cause as Error)?.message ?? cause)}`, { cause });
  }

  if (Array.isArray(parsed)) {
    return parsed.map((server, index) => parseServer(server, undefined, file, `[${index}]`));
  }
  if (isRecord(parsed) && isRecord(parsed.mcpServers)) {
    return Object.entries(parsed.mcpServers).map(([name, server]) => parseServer(server, name, file, `mcpServers.${name}`));
  }
  configFailure(file, '$', '必须是 server 数组或包含 mcpServers 对象');
}

/** 项目级配置：<cwd>/.mcp.json（优先，支持两种格式） */
export function loadProjectMcpConfig(cwd: string): McpServerConfig[] {
  const file = join(cwd, PROJECT_MCP_FILE);
  if (!existsSync(file)) return [];
  return parseServerList(readFileSync(file, 'utf8'), file);
}

/** 用户级配置：data/mcp.json（数组格式） */
export function loadUserMcpConfig(dataDir: string): McpServerConfig[] {
  const file = join(dataDir, 'mcp.json');
  if (!existsSync(file)) return [];
  return parseServerList(readFileSync(file, 'utf8'), file);
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

function serializeServer(server: McpServerConfig, file: string, path: string, includeName: boolean): Record<string, unknown> {
  const normalized = parseServer(server, includeName ? undefined : server.name, file, path);
  return {
    ...(includeName ? { name: normalized.name } : {}),
    ...(normalized.url ? { url: normalized.url } : { command: normalized.command, ...(normalized.args ? { args: normalized.args } : {}) }),
    ...(normalized.env ? { env: normalized.env } : {}),
    ...(normalized.startupTimeoutMs !== undefined ? { startupTimeoutMs: normalized.startupTimeoutMs } : {}),
    ...(normalized.timeoutMs !== undefined ? { timeoutMs: normalized.timeoutMs } : {}),
    ...(normalized.toolDanger ? { toolDanger: normalized.toolDanger } : {}),
  };
}

/** 写入项目级 .mcp.json（Claude Code 兼容 mcpServers 对象格式） */
export function saveProjectMcpConfig(cwd: string, servers: McpServerConfig[]): void {
  const file = join(cwd, PROJECT_MCP_FILE);
  const obj: Record<string, unknown> = {};
  for (const [index, server] of servers.entries()) {
    const normalized = parseServer(server, undefined, file, `[${index}]`);
    obj[normalized.name] = serializeServer(normalized, file, `mcpServers.${normalized.name}`, false);
  }
  writeFileSync(file, JSON.stringify({ mcpServers: obj }, null, 2), 'utf8');
}

export function saveMcpConfig(dataDir: string, servers: McpServerConfig[]): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'mcp.json');
  const serialized = servers.map((server, index) => serializeServer(server, file, `[${index}]`, true));
  writeFileSync(file, JSON.stringify(serialized, null, 2), 'utf8');
}

// ── JSON-RPC 客户端 ──────────────────────────
interface PendingRpc {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'MCP request aborted');
  error.name = 'AbortError';
  return error;
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export function connectMcp(cfg: McpServerConfig): Promise<McpClient> {
  return new Promise((resolve, reject) => {
    if (!cfg.command) {
      reject(new McpConfigError(cfg.name, 'stdio 连接缺少 command'));
      return;
    }
    const proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // P0-3 环境净化：MCP server 子进程不继承密钥类变量（env.ts 统一策略）；
      // cfg.env 显式配置的变量仍传入（用户主动声明）
      env: { ...sanitizedEnv(), ...(cfg.env ?? {}) },
      windowsHide: true,
    });
    let buf = '';
    let stderrTail = '';
    let nextId = 1;
    const pending = new Map<number, PendingRpc>();
    const toolMap = new Map<string, McpToolInfo>();
    let closed = false;
    let closeRequested = false;
    let closePromiseResolve!: () => void;
    const closePromise = new Promise<void>(resolveClose => { closePromiseResolve = resolveClose; });

    const appendStderr = (chunk: Buffer): void => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    };

    const failAll = (err: Error) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
        p.reject(err);
      }
      pending.clear();
    };

    const sendNotification = (method: string, params: unknown): void => {
      if (closed || !proc.stdin || proc.stdin.destroyed) return;
      try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* 子进程已关闭 */ }
    };

    const send = (method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> => {
      const id = nextId++;
      return new Promise((res, rej) => {
        if (closed || closeRequested) {
          rej(new Error(`MCP ${cfg.name} 连接已关闭`));
          return;
        }
        const timer = setTimeout(() => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
          rej(new Error(`MCP ${cfg.name} ${method} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        const onAbort = (): void => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          clearTimeout(p.timer);
          if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
          sendNotification('notifications/cancelled', { requestId: id, reason: String(signal?.reason ?? 'aborted') });
          rej(abortError(signal));
        };
        pending.set(id, { resolve: res, reject: rej, timer, signal, onAbort });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        } catch (cause) {
          pending.delete(id);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          rej(cause as Error);
        }
      });
    };

    proc.stderr!.on('data', appendStderr);

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
          if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
          if (msg.error) p.reject(new Error(`MCP ${cfg.name} ${msg.error?.message ?? 'error'}`));
          else p.resolve(msg.result);
        }
      }
    });

    proc.on('error', (e) => {
      closed = true;
      failAll(e);
      closePromiseResolve();
      reject(e);
    });
    proc.on('exit', (code, signal) => {
      const diagnostics = stderrTail.trim();
      if (!closed) {
        closed = true;
        const suffix = diagnostics ? `：${diagnostics}` : '';
        failAll(new Error(`MCP ${cfg.name} 进程退出（code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}）${suffix}`));
      }
      closePromiseResolve();
    });

    const startupTimeoutMs = cfg.startupTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const requestTimeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS;

    // 握手：initialize → initialized 通知 → tools/list。启动预算从 child spawn 后开始，
    // 不把操作系统创建进程的调度抖动误算为 MCP 协议无响应。
    const startHandshake = (): void => {
      send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wxnodus', version: WXNODUS_VERSION },
      }, Math.max(startupTimeoutMs, MIN_STARTUP_HANDSHAKE_MS))
        .then(() => {
          sendNotification('notifications/initialized', {});
          return send('tools/list', {}, Math.max(startupTimeoutMs, MIN_STARTUP_HANDSHAKE_MS));
        })
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
          connected: true,
          tools: [...toolMap.values()],
          async callTool(name, args, signal) {
            const r = await send('tools/call', { name, arguments: args ?? {} }, requestTimeoutMs, signal);
            const content = Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? '').join('\n') : String(r?.content ?? '');
            return (content || `MCP ${cfg.name} 工具 ${name} 返回空`).slice(0, 8000);
          },
          async close() {
            if (closed) return closePromise;
            if (!closeRequested) {
              closeRequested = true;
              failAll(new Error(`MCP ${cfg.name} 连接已关闭`));
              try { proc.stdin!.end(); } catch { /* 子进程已关闭 */ }
            }
            const graceful = await Promise.race([
              closePromise.then(() => true),
              new Promise<false>(done => setTimeout(() => done(false), CLOSE_GRACE_MS)),
            ]);
            if (graceful) return;
            if (proc.pid) await terminateProcessTree(proc.pid, CLOSE_GRACE_MS);
            else { try { proc.kill(); } catch { /* 子进程可能已退出 */ } }
            const killed = await Promise.race([
              closePromise.then(() => true),
              new Promise<false>(done => setTimeout(() => done(false), CLOSE_GRACE_MS)),
            ]);
            if (!killed) throw new Error(`MCP ${cfg.name} 子进程关闭超时`);
          },
        });
      })
      .catch(async (e) => {
        const diagnostics = stderrTail.trim();
        const baseMessage = String(e?.message ?? e);
        const failure = diagnostics && !baseMessage.includes(diagnostics)
          ? new Error(`${baseMessage}：${diagnostics.slice(-STDERR_TAIL_CHARS)}`)
          : e as Error;
        if (!closeRequested && !closed) {
          closeRequested = true;
          try { proc.stdin!.end(); } catch { /* 子进程已关闭 */ }
          if (proc.pid) await terminateProcessTree(proc.pid, CLOSE_GRACE_MS);
          else { try { proc.kill(); } catch { /* 子进程已关闭 */ } }
        }
        await Promise.race([
          closePromise,
          new Promise<void>(done => setTimeout(done, CLOSE_GRACE_MS)),
        ]);
        reject(failure);
      });
    };
    proc.once('spawn', startHandshake);
  });
}

// 并发连接所有配置的 server（失败逐个降级，返回成功列表）
export async function connectAllMcp(dataDir: string, opts: { cwd?: string; strict?: boolean } = {}): Promise<McpClient[]> {
  const cfgs = loadMcpConfig(dataDir, opts).filter(cfg => cfg.source !== 'project' || !opts.cwd || isProjectMcpTrusted(dataDir, opts.cwd, cfg));
  const results = await Promise.allSettled(cfgs.map(cfg => (cfg.url ? connectMcpHttp(cfg as McpServerConfig & { url: string }) : connectMcp(cfg))));
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
        connected: false,
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
        danger: c.server.toolDanger?.[t.name] === true,
        canonical: { namespace: 'mcp', source: c.server.name },
        async run(args, ctx) {
          return c.callTool(t.name, args, ctx.signal);
        },
      };
    }
  }
  return out;
}

// 关闭全部客户端；全部尝试后再报告失败。
export async function closeAllMcp(clients: readonly McpClient[]): Promise<void> {
  const results = await Promise.allSettled(clients.map(client => Promise.resolve().then(() => client.close())));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length > 0) throw new Error(`${failures.length} 个 MCP 客户端关闭失败`);
}

// ── Streamable HTTP 传输（MCP 2025-06-18+ 协议）────────────
// 设计：远程 MCP server（url 配置）——POST JSON-RPC，Accept 兼容 SSE/JSON 双响应；
//       initialize 响应头 Mcp-Session-Id 后续请求回传；失败干净降级。
//       配置形态：McpServerConfig.url（与 command 二选一，/mcp add-http <名称> <url>）
export interface McpHttpClient extends McpClient {}

export interface McpHttpConnectOptions {
  /** Explicitly permits a local loopback fixture/server; non-loopback targets always use DNS/IP policy. */
  allowLoopback?: boolean;
}

const HTTP_TIMEOUT_MS = 20_000;

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === 'localhost.' || host === '127.0.0.1' || host === '::1';
  } catch { return false; }
}

/** 解析 SSE 或 JSON 响应体 → JSON-RPC 结果，正文先受字节上限约束。 */
async function parseMcpResponse(resp: Response): Promise<any> {
  const contentLength = Number(resp.headers.get('content-length') ?? 0);
  if (contentLength > HTTP_RESPONSE_LIMIT_BYTES) {
    throw new Error(`MCP HTTP 响应过大（>${HTTP_RESPONSE_LIMIT_BYTES} bytes）`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (resp.body) {
    const reader = resp.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > HTTP_RESPONSE_LIMIT_BYTES) {
          await reader.cancel();
          throw new Error(`MCP HTTP 响应过大（>${HTTP_RESPONSE_LIMIT_BYTES} bytes）`);
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    let last: any = null;
    for (const chunk of text.split(/\r?\n\r?\n/)) {
      const data = chunk.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try { last = JSON.parse(data); } catch { /* 忽略坏帧，保留后续有效帧 */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** 连接 Streamable HTTP MCP server */
export async function connectMcpHttp(cfg: McpServerConfig & { url: string }, options: McpHttpConnectOptions = {}): Promise<McpHttpClient> {
  const base = cfg.url.replace(/\/+$/, '');
  let sessionId: string | null = null;
  let nextId = 1;
  let closed = false;

  const post = async (
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    notification = false,
  ): Promise<any> => {
    if (closed) throw new Error(`MCP ${cfg.name} 连接已关闭`);
    if (!options.allowLoopback || !isLoopbackUrl(base)) {
      const outbound = await authorizeOutboundUrl(base);
      if (!outbound.ok) throw new Error(`MCP HTTP 出站目标被拒绝：${outbound.error.code}`);
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const id = notification ? undefined : nextId++;
    const resp = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
      signal: requestSignal(timeoutMs, signal),
    });
    const sid = resp.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!resp.ok) throw new Error(`MCP HTTP ${method} HTTP ${resp.status}`);
    const message = await parseMcpResponse(resp);
    if (notification) return null;
    if (!message || message.id !== id) {
      throw new Error(`MCP HTTP ${method} response id correlation failed`);
    }
    if (message.error) throw new Error(`MCP HTTP ${method} 错误：${message.error.message ?? 'unknown'}`);
    return message.result ?? null;
  };

  const startupTimeoutMs = cfg.startupTimeoutMs ?? HTTP_TIMEOUT_MS;
  const requestTimeoutMs = cfg.timeoutMs ?? HTTP_TIMEOUT_MS;

  // 握手：initialize → initialized 通知 → tools/list
  await post('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wxnodus', version: WXNODUS_VERSION },
  }, startupTimeoutMs);
  await post('notifications/initialized', {}, startupTimeoutMs, undefined, true);
  const list = await post('tools/list', {}, startupTimeoutMs);
  const tools: any[] = list?.tools ?? [];
  const toolMap = new Map<string, McpToolInfo>();
  for (const t of tools) {
    const name = String(t?.name ?? '');
    if (!name) continue;
    toolMap.set(name, { server: cfg.name, name, description: String(t?.description ?? ''), inputSchema: t?.inputSchema });
  }
  return {
    server: cfg,
    connected: true,
    tools: [...toolMap.values()],
    async callTool(name, args, signal) {
      const r = await post('tools/call', { name, arguments: args ?? {} }, requestTimeoutMs, signal);
      const content = Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? '').join('\n') : String(r?.content ?? '');
      return (content || `MCP ${cfg.name} 工具 ${name} 返回空`).slice(0, 8000);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      const headers: Record<string, string> = { 'Mcp-Session-Id': sessionId };
      const resp = await fetch(base, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!resp.ok) throw new Error(`MCP HTTP session close HTTP ${resp.status}`);
      sessionId = null;
    },
  };
}
