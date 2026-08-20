// src/kernel/lspClient.ts — LSP 集成（gap P2「LSP 集成」落地，2026-08-18）
// 最小 stdio JSON-RPC（Content-Length 帧）LSP 客户端：initialize → didOpen →
// 拉取诊断（3.17 pull，旧服务器回退 publishDiagnostics 通知收集）→ hover/definition。
// 服务器发现：settings.lsp.servers 显式配置 + 内置 typescript-language-server 探测
// （PATH 或 <cwd>/node_modules/.bin）——未找到时诚实报错给安装指引，绝不假装诊断。
// 会话按 (id,cwd) 缓存复用（上限 4 个，LRU 驱逐）；请求全带超时，异常归一为错误文本。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const LSP_INIT_TIMEOUT_MS = 15_000;
export const LSP_REQUEST_TIMEOUT_MS = 20_000;
export const LSP_PUBLISH_GRACE_MS = 1500;
export const LSP_MAX_SESSIONS = 4;

export interface LspServerSpec {
  id: string;
  command: string;
  args?: string[];
  /** 文件 glob 匹配（简单 * 通配，如双星号 glob 或 *.py） */
  pattern?: string;
  /** 语言 id（按扩展名映射，如 typescript/python/rust） */
  languages?: string[];
}

export interface LspDiagnostic {
  line: number; // 1-based
  col: number;  // 1-based
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code?: string;
  source?: string;
}

const SEVERITY: Record<number, LspDiagnostic['severity']> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

export function fileUri(p: string): string {
  return pathToFileURL(resolve(p)).href;
}
export function uriToPath(uri: string): string {
  try { return fileURLToPath(uri); } catch { return uri; }
}

// ── 服务器发现（纯函数可单测）──────────────────────────────
export const LANG_BY_EXT: Record<string, string[]> = {
  '.ts': ['typescript'], '.tsx': ['typescriptreact'], '.js': ['javascript'], '.jsx': ['javascriptreact'],
  '.py': ['python'], '.rs': ['rust'], '.go': ['go'], '.c': ['c'], '.h': ['c'], '.cpp': ['cpp'], '.hpp': ['cpp'],
  '.java': ['java'], '.cs': ['csharp'], '.php': ['php'], '.rb': ['ruby'], '.lua': ['lua'], '.sh': ['shellscript'],
  '.sql': ['sql'], '.vue': ['vue'], '.svelte': ['svelte'], '.json': ['json'], '.html': ['html'], '.css': ['css'],
};

/** settings.lsp.servers + 内置 typescript-language-server（探到才列，不假装） */
export function discoverLspServers(settings: Record<string, any> | undefined, cwd: string): LspServerSpec[] {
  const list: LspServerSpec[] = [];
  const cfg = settings?.lsp as { servers?: unknown } | undefined;
  if (cfg && Array.isArray(cfg.servers)) {
    for (const s of cfg.servers) {
      const spec = s as LspServerSpec;
      if (!spec || typeof spec.id !== 'string' || typeof spec.command !== 'string') continue;
      list.push({ id: spec.id, command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], pattern: spec.pattern, languages: spec.languages });
    }
  }
  const ts = resolveTypeScriptServer(cwd);
  if (ts) list.push({ id: 'typescript', command: ts, args: ['--stdio'], languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'] });
  return list;
}

/** typescript-language-server 探测：cwd/node_modules/.bin 优先，其次 PATH（命令名裸用） */
export function resolveTypeScriptServer(cwd: string): string | null {
  const local = process.platform === 'win32'
    ? join(cwd, 'node_modules', '.bin', 'typescript-language-server.cmd')
    : join(cwd, 'node_modules', '.bin', 'typescript-language-server');
  if (existsSync(local)) return local;
  return 'typescript-language-server'; // PATH 解析交给 spawn（ENOENT → 诚实报错）
}

function globMatch(pattern: string, relPath: string): boolean {
  const re = '^' + pattern
    .split(sep).join('/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__D__').replace(/\*/g, '[^/]*').replace(/__D__/g, '.*') + '$';
  try { return new RegExp(re).test(relPath.split(sep).join('/')); } catch { return false; }
}

/** 按文件挑服务器：languages（扩展名映射）优先，pattern 次之 */
export function serverForFile(specs: LspServerSpec[], filePath: string): LspServerSpec | null {
  const rel = filePath;
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  const langs = LANG_BY_EXT[ext] ?? [];
  return specs.find(s => s.languages?.some(l => langs.includes(l))) ?? specs.find(s => s.pattern && globMatch(s.pattern, rel)) ?? null;
}

// ── stdio JSON-RPC 会话 ────────────────────────────────────
interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }

export class LspSession {
  private readonly child: ChildProcess;
  private id = 0;
  private buf = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private publishByUri = new Map<string, LspDiagnostic[]>();
  private closed = false;

  private constructor(child: ChildProcess) { this.child = child; }

  static async start(spec: LspServerSpec, cwd: string): Promise<LspSession> {
    const session = new Promise<LspSession>((resolveP, rejectP) => {
      const child = spawn(spec.command, spec.args ?? [], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const s = new LspSession(child);
      let settled = false;
      const fail = (e: Error) => { if (!settled) { settled = true; try { child.kill(); } catch { /* 忽略 */ } rejectP(e); } };
      const timer = setTimeout(() => fail(new Error(`LSP 服务器启动超时（${LSP_INIT_TIMEOUT_MS / 1000}s）：${spec.command}`)), LSP_INIT_TIMEOUT_MS);
      child.on('error', (e: any) => {
        if (settled) return;
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
          clearTimeout(timer);
          fail(new Error(`未找到语言服务器「${spec.command}」——npm i -g typescript-language-server 安装，或在 settings.lsp.servers 配置（/config set lsp {...}）`));
        } else fail(new Error(`LSP 服务器启动失败：${String(e?.message ?? e)}`));
      });
      child.stdout?.on('data', (d: Buffer) => s.onData(d));
      child.on('exit', () => { clearTimeout(timer); if (!settled) { settled = true; try { child.kill(); } catch { /* 忽略 */ } rejectP(new Error(`LSP 服务器提前退出（${spec.command}）`)); } });
      s.request('initialize', {
        processId: null,
        rootUri: fileUri(cwd),
        capabilities: {},
      }).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.notify('initialized', {});
        resolveP(s);
      }).catch(fail);
    });
    return session;
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buf.slice(0, sep).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.slice(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.slice(sep + 4 + len);
      try { this.dispatch(JSON.parse(body)); } catch { /* 坏帧丢弃 */ }
    }
  }

  private send(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.child.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin?.write(body);
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`LSP ${p.method} 错误：${msg.error.message ?? JSON.stringify(msg.error).slice(0, 120)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = String(msg.params?.uri ?? '');
      const items = Array.isArray(msg.params?.diagnostics) ? msg.params.diagnostics.map((x: any) => ({
        line: Number(x.range?.start?.line ?? 0) + 1,
        col: Number(x.range?.start?.character ?? 0) + 1,
        severity: SEVERITY[x.severity] ?? 'info',
        message: String(x.message ?? '').slice(0, 300),
        code: x.code !== undefined ? String(x.code) : undefined,
        source: typeof x.source === 'string' ? x.source : undefined,
      })) : [];
      this.publishByUri.set(uri, items);
    }
    // 其余通知忽略（不阻塞）
  }

  request(method: string, params: unknown, timeoutMs = LSP_REQUEST_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new Error('LSP 会话已关闭'));
    const id = ++this.id;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`LSP ${method} 超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveP, reject: rejectP, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  async diagnostics(filePath: string, text: string): Promise<LspDiagnostic[]> {
    const uri = fileUri(filePath);
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.languageId(filePath), version: 1, text } });
    this.publishByUri.set(uri, []);
    // 优先 3.17 拉取诊断；不支持（-32601）→ 等 publishDiagnostics 通知宽限期
    try {
      const res = await this.request('textDocument/diagnostic', { textDocument: { uri } });
      if (res?.kind === 'full' && Array.isArray(res.items)) {
        return res.items.map((x: any) => ({
          line: Number(x.range?.start?.line ?? 0) + 1,
          col: Number(x.range?.start?.character ?? 0) + 1,
          severity: SEVERITY[x.severity] ?? 'info',
          message: String(x.message ?? '').slice(0, 300),
          code: x.code !== undefined ? String(x.code) : undefined,
          source: typeof x.source === 'string' ? x.source : undefined,
        }));
      }
    } catch { /* pull 不支持/失败 → 通知收集兜底 */ }
    await new Promise(r => setTimeout(r, LSP_PUBLISH_GRACE_MS));
    return this.publishByUri.get(uri) ?? [];
  }

  async hover(filePath: string, line: number, col: number): Promise<string> {
    const res = await this.request('textDocument/hover', {
      textDocument: { uri: fileUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, col - 1) },
    });
    return hoverToText(res);
  }

  async definition(filePath: string, line: number, col: number): Promise<string> {
    const res = await this.request('textDocument/definition', {
      textDocument: { uri: fileUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, col - 1) },
    });
    const locs = Array.isArray(res) ? res : res ? [res] : [];
    if (!locs.length) return '（无定义位置）';
    return locs.map((l: any) => {
      if (typeof l?.uri === 'string' && l.range?.start) {
        return `${uriToPath(l.uri)}:${Number(l.range.start.line) + 1}:${Number(l.range.start.character) + 1}`;
      }
      return '（定义位置不可解析）';
    }).join('\n');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.request('shutdown', null, 3000); } catch { /* 忽略 */ }
    try { this.notify('exit', null); } catch { /* 忽略 */ }
    try { this.child.kill(); } catch { /* 忽略 */ }
    // 等待真实退出（Windows 下子进程 cwd 句柄持锁——上层清理目录需等句柄释放）
    await new Promise<void>((resolveP) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolveP();
      const timer = setTimeout(resolveP, 1000);
      this.child.once('exit', () => { clearTimeout(timer); resolveP(); });
    });
  }

  private languageId(filePath: string): string {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
    return (LANG_BY_EXT[ext] ?? ['plaintext'])[0]!;
  }
}

export function hoverToText(res: any): string {
  if (!res) return '（无悬停信息）';
  const c = res.contents;
  if (typeof c === 'string') return c.slice(0, 2000);
  const parts = Array.isArray(c) ? c : [c];
  return parts.map((p: any) => {
    if (typeof p === 'string') return p;
    if (p?.value) return String(p.value);
    return '';
  }).filter(Boolean).join('\n').slice(0, 2000) || '（无悬停信息）';
}

// ── 会话缓存（LRU，上限 4）─────────────────────────────────
const sessionCache = new Map<string, Promise<LspSession>>();

/** 取（或启动）LSP 会话——启动失败逐调用重试（ENOENT 用户装好后自然恢复） */
export function lspSessionFor(spec: LspServerSpec, cwd: string): Promise<LspSession> {
  const key = `${spec.id}|${cwd}`;
  let p = sessionCache.get(key);
  if (!p) {
    p = LspSession.start(spec, cwd).catch(e => {
      sessionCache.delete(key); // 失败不缓存（下次重试）
      throw e;
    });
    sessionCache.set(key, p);
    if (sessionCache.size > LSP_MAX_SESSIONS) {
      const oldest = sessionCache.keys().next().value;
      if (oldest !== undefined) {
        const evicted = sessionCache.get(oldest);
        sessionCache.delete(oldest);
        void evicted?.then(s => s.close()).catch(() => { /* 忽略 */ });
      }
    }
  }
  return p;
}

export function closeAllLspSessions(): Promise<void> {
  const all = [...sessionCache.values()];
  sessionCache.clear();
  return Promise.all(all.map(p => p.then(s => s.close()).catch(() => { /* 忽略 */ }))).then(() => undefined);
}
