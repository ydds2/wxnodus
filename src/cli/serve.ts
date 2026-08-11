// src/cli/serve.ts — AI 网关（颠覆性改造：CLI 变本地底座，多前端共享一个
// agent/记忆/权限/审计面）
// 路由：
//   GET  /health              状态（版本/模型/数据目录/命令数）
//   POST /rpc                 { method, params }——method 见 RpcMethods
//   GET  /events              SSE 事件流（agent.token/system.notice/agent.tool 等）
// 绑定 127.0.0.1（仅本机）；端口 WXNODUS_SERVE_PORT ?? 4789
// 客户端示例：curl -s http://127.0.0.1:4789/health
//            curl -s -X POST http://127.0.0.1:4789/rpc -H 'Content-Type: application/json' \
//                 -d '{"method":"chat","params":{"prompt":"你好"}}'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

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
  commandBus: { execute(cmd: string): Promise<{ ok: boolean; output?: string; error?: string }> };
  config: { get(p: string): Record<string, any> };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1_000_000) reject(new Error('body 过大')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, code: number, obj: unknown) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(body);
};

export function startServeServer(k: ServeKernel, port = 4789): { close(): Promise<void>; port: number } {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      // CORS 预检
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && url.pathname === '/health') {
        let cmdCount = 0;
        try { cmdCount = (k.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c; } catch { /* 内存模式 */ }
        json(res, 200, {
          ok: true, service: 'wxnodus-serve', version: '3.0.0',
          model: (k.config.get('settings') as any)?.model ?? '',
          dataDir: k.dataDir, cwd: k.cwd,
          messages: cmdCount,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        // SSE 事件流：总线事件实时转发（外部工具/面板可订阅）
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

      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = JSON.parse(await readBody(req) || '{}') as { method?: string; params?: Record<string, any> };
        const method = String(body.method ?? '');
        const params = (body.params ?? {}) as Record<string, any>;
        switch (method) {
          case 'chat': {
            const prompt = String(params.prompt ?? '');
            if (!prompt.trim()) { json(res, 400, { ok: false, error: 'prompt 必填' }); return; }
            if (params.session_id && k.agent.setSessionId) k.agent.setSessionId(String(params.session_id));
            const r = await k.agent.run(prompt);
            json(res, 200, { ok: r.ok, text: r.text, turns: r.turns, interrupted: r.interrupted });
            return;
          }
          case 'command': {
            const cmd = String(params.command ?? '');
            if (!cmd.trim()) { json(res, 400, { ok: false, error: 'command 必填' }); return; }
            const r = await k.commandBus.execute(cmd);
            json(res, 200, { ok: r.ok, output: r.output ?? '', error: r.error });
            return;
          }
          case 'memory.search': {
            if (!k.mem.recallHybrid) { json(res, 200, { ok: true, hits: [] }); return; }
            const hits = await k.mem.recallHybrid(String(params.query ?? ''), { limit: Number(params.limit ?? 5) });
            json(res, 200, { ok: true, hits });
            return;
          }
          case 'memory.recall': {
            const rows = k.mem.recall(String(params.session_id ?? 'default'));
            json(res, 200, { ok: true, messages: rows });
            return;
          }
          case 'sessions': {
            let rows: unknown[] = [];
            try {
              rows = k.db.prepare('SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50').all() as unknown[];
            } catch { /* 内存模式 */ }
            json(res, 200, { ok: true, sessions: rows });
            return;
          }
          default:
            json(res, 400, { ok: false, error: `未知 method：${method}（支持 chat/command/memory.search/memory.recall/sessions）` });
        }
        return;
      }

      json(res, 404, { ok: false, error: `未找到路由：${req.method} ${url.pathname}（GET /health、POST /rpc、GET /events）` });
    } catch (e: any) {
      json(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  });

  server.listen(port, '127.0.0.1');
  return {
    port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
