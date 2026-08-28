// src/hermes-gateway/server.ts — wxnodus ↔ hermes-tui 桥接网关（2026-08-28 用户裁决迁移）
// hermes-agent ui-tui（MIT，github.com/NousResearch/hermes-agent）是 WS JSON-RPC 客户端——
// 本模块在 wxnodus 进程内实现其协议端：RPC 方法表映射到 wxnodus agent/bus/command 面，
// wxnodus 事件流翻译为 hermes GatewayEvent 形状广播。TUI 以子进程 attach
// （HERMES_TUI_GATEWAY_URL=ws://127.0.0.1:<port>）——UI 与内核零编译耦合。
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface HermesGatewayDeps {
  db: Database.Database;
  bus: { on(type: string, fn: (e: any) => void): () => void };
  agent: {
    run(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; text: string; turns: number; interrupted?: boolean }>;
    abort(): void;
    steer(text: string): boolean;
    getSessionId?(): string;
    setSessionId?(id: string): void;
  };
  commandBus: { execute(cmd: string, ctx?: unknown): Promise<unknown> };
  config: { get(p: string): Record<string, any>; setKey?(scope: string, key: string, v: unknown): void };
  getSessionDir?(): string;
}

export interface HermesGatewayHandle {
  port: number;
  close(): Promise<void>;
  /** 供测试/宿主直接注入 hermes 形状事件 */
  emitEvent(ev: Record<string, unknown>): void;
}

type RpcHandler = (params: Record<string, any>) => Promise<unknown> | unknown;

/**
 * 启动 hermes 协议桥接网关（127.0.0.1 随机端口）。
 * 协议：JSON-RPC 2.0 over WebSocket——请求 {id,jsonrpc,method,params} → {id,result|error}；
 * 事件推送 {jsonrpc:'2.0',method:'event',params:{type,payload,session_id}}；连接即发 gateway.ready。
 */
export function createHermesGateway(deps: HermesGatewayDeps): Promise<HermesGatewayHandle> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  // 审批/澄清/密钥 pending 表：request_id → resolve（hermes TUI 经 *.respond RPC 回答）
  const pendingApprovals = new Map<string, (choice: string) => void>();
  const pendingClarifies = new Map<string, (answer: string) => void>();
  const pendingSecrets = new Map<string, (v: string) => void>();
  let activeSession = deps.agent.getSessionId?.() ?? 'default';
  const runSignals = new Map<string, AbortController>();

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('message', data => {
        void handleFrame(ws, String(data)).catch(err => {
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String((err as Error)?.message ?? err).slice(0, 300) } })); } catch { /* 已关闭 */ }
        });
      });
      // 连接即绪（hermes 约定：ready 后 TUI 才发首个请求）
      sendEvent(ws, { type: 'gateway.ready', payload: { heartbeat: true } });
    });
  });

  const sendEvent = (ws: WebSocket, ev: Record<string, any>) => {
    try { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { session_id: activeSession, ...ev } })); } catch { /* 已关闭 */ }
  };
  const broadcast = (ev: Record<string, any>) => {
    for (const ws of clients) sendEvent(ws, ev);
  };

  // ── RPC 方法表 ──
  const sessions = () => {
    try {
      return deps.db.prepare('SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 100').all() as Array<{ id: string; title: string; updated_at: number }>;
    } catch { return []; }
  };
  const sessionInfo = (id: string) => ({ id, title: (sessions().find(s => s.id === id)?.title) ?? '会话', updated_at: sessions().find(s => s.id === id)?.updated_at ?? Date.now() });

  const handlers: Record<string, RpcHandler> = {
    'gateway.ping': () => ({ ok: true }),
    // —— 会话面 ——
    'session.most_recent': () => sessionInfo(activeSession),
    'session.list': () => ({ sessions: sessions().map(s => ({ ...sessionInfo(s.id), archived: false })) }),
    'session.create': () => {
      activeSession = `hermes-${Date.now().toString(36)}`;
      deps.agent.setSessionId?.(activeSession);
      return sessionInfo(activeSession);
    },
    'session.activate': p => {
      activeSession = String(p?.session_id ?? activeSession);
      deps.agent.setSessionId?.(activeSession);
      return sessionInfo(activeSession);
    },
    'session.resume': p => {
      activeSession = String(p?.session_id ?? activeSession);
      deps.agent.setSessionId?.(activeSession);
      return sessionInfo(activeSession);
    },
    'session.info': () => sessionInfo(activeSession),
    'session.title': p => {
      try { deps.db.prepare('UPDATE sessions SET title=? WHERE id=?').run(String(p?.title ?? ''), activeSession); } catch { /* 忽略 */ }
      return { ok: true };
    },
    'session.close': () => ({ ok: true }),
    'session.delete': () => ({ ok: true }),
    'session.active_list': () => ({ sessions: [sessionInfo(activeSession)] }),
    'session.usage': () => {
      try {
        const row = deps.db.prepare('SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM usage_stats WHERE session_id=?').get(activeSession) as { t: number } | undefined;
        return { total_tokens: row?.t ?? 0 };
      } catch { return { total_tokens: 0 }; }
    },
    'session.steer': p => ({ ok: deps.agent.steer(String(p?.text ?? '')) }),
    'session.interrupt': () => {
      const sig = runSignals.get(activeSession);
      sig?.abort();
      deps.agent.abort();
      return { ok: true };
    },
    // —— 用户提交（agent 回合）——
    'command.dispatch': async p => {
      const prompt = String(p?.text ?? p?.prompt ?? '');
      if (!prompt.trim()) return { ok: false, error: '空输入' };
      broadcast({ type: 'message.start' });
      broadcast({ type: 'status.update', payload: { kind: 'thinking', text: '正在思考…' } });
      const ac = new AbortController();
      runSignals.set(activeSession, ac);
      try {
        const r = await deps.agent.run(prompt, { signal: ac.signal });
        broadcast({ type: 'message.complete', payload: { text: r.text, reasoning: undefined, failure_reason: r.ok ? undefined : '回合未成功' } });
        return { ok: r.ok, text: r.text, turns: r.turns };
      } catch (e: any) {
        broadcast({ type: 'error', payload: { message: String(e?.message ?? e).slice(0, 300) } });
        return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
      } finally {
        runSignals.delete(activeSession);
      }
    },
    // —— slash 命令 ——
    'slash.exec': async p => {
      const cmd = String(p?.command ?? '');
      if (!cmd.startsWith('/')) return { ok: false, error: '非 slash 命令' };
      const out = await deps.commandBus.execute(cmd);
      const r = out as { ok?: boolean; output?: string; error?: unknown } | string;
      return { ok: r && typeof r === 'object' ? r.ok !== false : true, output: typeof r === 'string' ? r : String(r?.output ?? r?.error ?? '') };
    },
    // —— 配置 ——
    'config.get': p => {
      const settings = deps.config.get('settings') ?? {};
      return p?.key ? { value: (settings as any)[String(p.key)] } : { config: { settings } };
    },
    'config.set': p => {
      try {
        deps.config.setKey?.('settings', String(p?.key ?? ''), p?.value);
        return { ok: true };
      } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
    },
    // —— 模型 ——
    'model.options': () => {
      const s = deps.config.get('settings') ?? {};
      return { options: [{ id: String((s as any).model ?? 'default'), label: String((s as any).model ?? '当前模型'), current: true }] };
    },
    'model.save_key': () => ({ ok: true, hint: '请用 wxnodus /model set-key 配置' }),
    'model.disconnect': () => ({ ok: true }),
    // —— 审批/澄清/密钥应答（UI → 内核）——
    'approval.respond': p => {
      const rid = String(p?.request_id ?? '');
      const fn = pendingApprovals.get(rid);
      pendingApprovals.delete(rid);
      fn?.(String(p?.choice ?? 'deny'));
      return { ok: true };
    },
    'clarify.respond': p => {
      const rid = String(p?.request_id ?? '');
      const fn = pendingClarifies.get(rid);
      pendingClarifies.delete(rid);
      fn?.(String(p?.answer ?? ''));
      return { ok: true };
    },
    'secret.respond': p => {
      const rid = String(p?.request_id ?? '');
      const fn = pendingSecrets.get(rid);
      pendingSecrets.delete(rid);
      fn?.(String(p?.value ?? ''));
      return { ok: true };
    },
    'sudo.respond': p => {
      const rid = String(p?.request_id ?? '');
      const fn = pendingSecrets.get(rid);
      pendingSecrets.delete(rid);
      fn?.(String(p?.value ?? ''));
      return { ok: true };
    },
    // —— hermes 特有彩蛋（桩——诚实空实现）——
    'pet.info.meta': () => ({ cells: null, meta: null, note: 'wxnodus：宠物面板未启用' }),
    'pet.cells': () => ({ cells: [] }),
    'pet.gallery': () => ({ gallery: [] }),
    'pet.select': () => ({ ok: true }),
    'image.detach': () => ({ ok: true }),
    'completion.complete': () => ({ items: [] }),
    'history.search': () => ({ results: [] }),
  };

  async function handleFrame(ws: WebSocket, raw: string): Promise<void> {
    let msg: { id?: string; method?: string; params?: Record<string, any> };
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, method } = msg;
    if (!method) return;
    const handler = handlers[method];
    if (!handler) {
      if (id !== undefined) { try { ws.send(JSON.stringify({ id, error: { code: -32601, message: `方法未实现：${method}` } })); } catch { /* 已关闭 */ } }
      return;
    }
    try {
      const result = await handler(msg.params ?? {});
      if (id !== undefined) { try { ws.send(JSON.stringify({ id, result })); } catch { /* 已关闭 */ } }
    } catch (e: any) {
      if (id !== undefined) { try { ws.send(JSON.stringify({ id, error: { code: -32000, message: String(e?.message ?? e).slice(0, 300) } })); } catch { /* 已关闭 */ } }
    }
  }

  // ── wxnodus 事件流 → hermes GatewayEvent 翻译 ──
  const offs: Array<() => void> = [];
  offs.push(deps.bus.on('agent.token', (e: any) => broadcast({ type: 'message.delta', payload: { text: String(e?.payload?.text ?? '') } })));
  offs.push(deps.bus.on('reasoning.delta', (e: any) => broadcast({ type: 'reasoning.delta', payload: { text: String(e?.payload?.text ?? '') } })));
  offs.push(deps.bus.on('agent.tool', (e: any) => {
    const p = e?.payload ?? {};
    if (p.phase === 'start') broadcast({ type: 'tool.start', payload: { tool_id: String(p.toolId ?? randomUUID()), name: String(p.name ?? ''), args_text: (() => { try { return JSON.stringify(p.args ?? {}); } catch { return ''; } })() } });
    else broadcast({ type: 'tool.complete', payload: { tool_id: String(p.toolId ?? ''), name: String(p.name ?? ''), result_text: '', duration_s: (Number(p.ms) || 0) / 1000, ...(p.ok === false ? { error: '工具失败' } : {}) } });
  }));
  offs.push(deps.bus.on('system.notice', (e: any) => broadcast({ type: 'notification.show', payload: { text: String(e?.payload?.text ?? ''), level: 'info', ttl_ms: 6000 } })));
  offs.push(deps.bus.on('agent.error', (e: any) => broadcast({ type: 'error', payload: { message: String(e?.payload?.message ?? '') } })));

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        emitEvent: broadcast,
        close: () => new Promise<void>(done => {
          for (const off of offs) { try { off(); } catch { /* 已退订 */ } }
          for (const ws of clients) { try { ws.close(); } catch { /* 已关闭 */ } }
          wss.close(() => server.close(() => done()));
        }),
      });
    });
  });
}
