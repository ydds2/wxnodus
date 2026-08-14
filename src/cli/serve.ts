// src/cli/serve.ts — AI 网关（P0-01：Bearer 认证 + 最小 /health/live + 严格预检 + CSRF + 结构化 body 上限）
// 路由：
//   GET  /health/live   最小存活探针（无认证、不泄漏 dataDir/cwd/model/统计）
//   GET  /health        完整状态（需 Bearer）
//   POST /rpc           { method, params }——method 见 RpcMethods（需 Bearer；跨源被 CSRF 拒绝）
//   GET  /events        SSE 事件流（需 Bearer）
// 绑定 127.0.0.1（仅本机）；端口 WXNODUS_SERVE_PORT ?? 4789；token WXNODUS_SERVE_TOKEN（未配置时除 /health/live 外全部 401）
// 客户端示例：curl -s http://127.0.0.1:4789/health/live
//            curl -s -X POST http://127.0.0.1:4789/rpc -H "Authorization: Bearer <token>" \
//                 -H 'Content-Type: application/json' -d '{"method":"chat","params":{"prompt":"你好"}}'
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
// W3-01：RPC 响应状态走共享 completionTransport 映射（failure 不藏在 HTTP 200 后面）
import { httpStatusForCompletion } from '../protocol/completionTransport.js';
import type { RunFinalStatus } from '../protocol/runs.js';
import { evaluateCsrf } from '../presentation/http/csrfPolicy.js';

export interface ServeKernel {
  dataDir: string;
  cwd: string;
  db: { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number } } };
  bus: { on(type: string, fn: (e: any) => void): () => void };
  mem: {
    recallHybrid?(q: string, o?: { limit?: number }): Promise<Array<{ id: number; content: string; score: number; session_id?: string }>>;
    recall(sessionId: string): Array<{ id: number; role: string; content: string; ts: number }>;
  };
  agent: { run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; getSessionId?(): string; setSessionId?(id: string): void };
  commandBus: { execute(cmd: string): Promise<{ ok: boolean; output?: string; error?: string; completionStatus?: RunFinalStatus }> };
  config: { get(p: string): Record<string, any> };
  /** W3 MCP facade：incoming Streamable HTTP handler（/mcp 挂载；Bearer/CSRF 前置后委托 SDK handler） */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface ServeSecurityOptions {
  /** Bearer token（未配置时除 /health/live 外全部 401 fail-closed） */
  token?: string;
  /** CORS origin allowlist（默认 WXNODUS_SERVE_ORIGINS 逗号分隔） */
  originAllowlist?: string[];
  /** 请求体上限字节（默认 1MB） */
  maxBodyBytes?: number;
}

const BODY_TOO_LARGE = 1_000_000;

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; code: 'HTTP_REQUEST_BODY_TOO_LARGE' }> {
  return new Promise((resolve, reject) => {
    let data = '';
    let overflow = false;
    req.on('data', chunk => {
      // 超限后继续排空流（不累积、不 destroy——让服务端能写出 413 响应）
      if (!overflow) {
        data += chunk;
        if (Buffer.byteLength(data) > maxBytes) overflow = true;
      }
    });
    req.on('end', () => resolve(overflow ? { ok: false, code: 'HTTP_REQUEST_BODY_TOO_LARGE' } : { ok: true, text: data }));
    req.on('error', reject);
    req.on('close', () => {
      if (overflow) resolve({ ok: false, code: 'HTTP_REQUEST_BODY_TOO_LARGE' });
    });
  });
}

const safeTokenCompare = (provided: Buffer, expected: string): boolean => {
  const expectedBuffer = Buffer.from(expected);
  return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
};

// W1-03：CORS 只回显 allowlist 内 Origin，永不 `*`（非浏览器客户端无 Origin 则不回 CORS 头）
function corsHeaders(req: IncomingMessage, allowlist: readonly string[]): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !allowlist.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
}

const json = (res: ServerResponse, req: IncomingMessage, code: number, obj: unknown, allowlist: readonly string[]) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req, allowlist) });
  res.end(body);
};

export function startServeServer(k: ServeKernel, port = 4789, opts: ServeSecurityOptions = {}): { close(): Promise<void>; port: number } {
  const token = opts.token ?? process.env.WXNODUS_SERVE_TOKEN ?? '';
  const allowlist = opts.originAllowlist
    ?? (process.env.WXNODUS_SERVE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const maxBodyBytes = opts.maxBodyBytes ?? BODY_TOO_LARGE;

  const bearerOf = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  };

  const authenticated = (req: IncomingMessage): boolean => {
    if (!token) return false;
    const bearer = bearerOf(req);
    return bearer !== null && safeTokenCompare(Buffer.from(bearer), token);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const csrf = evaluateCsrf({
      method: req.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : value])),
      originAllowlist: allowlist,
    });

    try {
      // CORS 预检：严格验证；浏览器预检（Origin + ACRM）通过后无需 Bearer（预检机制不带 Authorization）
      if (req.method === 'OPTIONS') {
        if (!csrf.ok) {
          json(res, req, 403, { ok: false, error: { code: csrf.code } }, allowlist);
          return;
        }
        if (req.headers.origin && req.headers['access-control-request-method']) {
          res.writeHead(204, corsHeaders(req, allowlist));
          res.end();
          return;
        }
        if (!authenticated(req)) {
          json(res, req, 401, { ok: false, error: { code: 'HTTP_TOKEN_MISSING' } }, allowlist);
          return;
        }
        res.writeHead(204, corsHeaders(req, allowlist));
        res.end();
        return;
      }

      // 最小存活探针：无认证、零泄漏
      if (req.method === 'GET' && url.pathname === '/health/live') {
        json(res, req, 200, { ok: true, service: 'wxnodus-serve', version: '3.0.0' }, allowlist);
        return;
      }

      // 状态修改请求：跨源 CSRF 判定先于认证（跨源携带有效 token 也拒绝）
      if (!csrf.ok) {
        json(res, req, 403, { ok: false, error: { code: csrf.code } }, allowlist);
        return;
      }

      // 除 /health/live 外全部 Bearer 认证
      if (!authenticated(req)) {
        json(res, req, 401, { ok: false, error: { code: 'HTTP_TOKEN_MISSING' } }, allowlist);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        let cmdCount = 0;
        try { cmdCount = (k.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c; } catch { /* 内存模式 */ }
        json(res, req, 200, {
          ok: true, service: 'wxnodus-serve', version: '3.0.0',
          model: (k.config.get('settings') as any)?.model ?? '',
          dataDir: k.dataDir, cwd: k.cwd,
          messages: cmdCount,
        }, allowlist);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        // SSE 事件流：总线事件实时转发（外部工具/面板可订阅；Bearer 认证）
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('event: ready\ndata: {"connected":true}\n\n');
        const offs: Array<() => void> = [];
        for (const type of ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'system.notice', 'voice.transcript']) {
          offs.push(k.bus.on(type, (e: any) => {
            try { res.write(`event: ${type}\ndata: ${JSON.stringify(e?.payload ?? {})}\n\n`); } catch { /* 连接断开 */ }
          }));
        }
        req.on('close', () => { for (const off of offs) { try { off(); } catch {} } });
        return;
      }

      // W3 MCP facade：incoming Streamable HTTP——MCP 客户端 POST/GET/DELETE（含 legacy SSE 会话与 DELETE 终止）
      // 在 CSRF（有 Origin 才放行 allowlist）+ Bearer 之后委托 SDK handler；响应由 handler 自行写出
      if (k.mcpHandler && url.pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
        await k.mcpHandler(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/rpc') {
        const bodyResult = await readBody(req, maxBodyBytes);
        if (!bodyResult.ok) {
          json(res, req, 413, { ok: false, error: { code: bodyResult.code } }, allowlist);
          return;
        }
        const body = JSON.parse(bodyResult.text || '{}') as { method?: string; params?: Record<string, any> };
        const method = String(body.method ?? '');
        const params = (body.params ?? {}) as Record<string, any>;
        switch (method) {
          case 'chat': {
            const prompt = String(params.prompt ?? '');
            if (!prompt.trim()) { json(res, req, 400, { ok: false, error: 'prompt 必填' }, allowlist); return; }
            if (params.session_id && k.agent.setSessionId) k.agent.setSessionId(String(params.session_id));
            const r = await k.agent.run(prompt);
            const status = httpStatusForCompletion(r.interrupted ? 'cancelled' : r.ok ? 'succeeded' : 'failed');
            json(res, req, status, { ok: r.ok, text: r.text, turns: r.turns, interrupted: r.interrupted }, allowlist);
            return;
          }
          case 'command': {
            const cmd = String(params.command ?? '');
            if (!cmd.trim()) { json(res, req, 400, { ok: false, error: 'command 必填' }, allowlist); return; }
            const r = await k.commandBus.execute(cmd);
            json(res, req, httpStatusForCompletion(r.completionStatus ?? (r.ok ? 'succeeded' : 'failed')), { ok: r.ok, output: r.output ?? '', error: r.error }, allowlist);
            return;
          }
          case 'memory.search': {
            if (!k.mem.recallHybrid) { json(res, req, 200, { ok: true, hits: [] }, allowlist); return; }
            const hits = await k.mem.recallHybrid(String(params.query ?? ''), { limit: Number(params.limit ?? 5) });
            json(res, req, 200, { ok: true, hits }, allowlist);
            return;
          }
          case 'memory.recall': {
            const rows = k.mem.recall(String(params.session_id ?? 'default'));
            json(res, req, 200, { ok: true, messages: rows }, allowlist);
            return;
          }
          case 'sessions': {
            let rows: unknown[] = [];
            try {
              rows = k.db.prepare('SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50').all() as unknown[];
            } catch { /* 内存模式 */ }
            json(res, req, 200, { ok: true, sessions: rows }, allowlist);
            return;
          }
          default:
            json(res, req, 400, { ok: false, error: `未知 method：${method}（支持 chat/command/memory.search/memory.recall/sessions）` }, allowlist);
        }
        return;
      }

      json(res, req, 404, { ok: false, error: `未找到路由：${req.method} ${url.pathname}（GET /health/live、GET /health、POST /rpc、GET /events）` }, allowlist);
    } catch (e: any) {
      json(res, req, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) }, allowlist);
    }
  });

  server.listen(port, '127.0.0.1');
  return {
    port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
