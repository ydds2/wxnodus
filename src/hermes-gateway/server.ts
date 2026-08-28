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
  /** 审批/澄清/密钥请求超时（fail-closed——超时 deny/''/null；默认 5 分钟人在回路） */
  requestTimeoutMs?: number;
}

export interface HermesGatewayHandle {
  port: number;
  close(): Promise<void>;
  /** 供测试/宿主直接注入 hermes 形状事件 */
  emitEvent(ev: Record<string, unknown>): void;
  /** 内核审批回调面（cli/index.ts bridges gateway 中介对接）：
   *  broadcast approval.request → TUI 面板 → approval.respond → resolve。
   *  hermes approval 为单槽协议（request/respond 均不带 request_id）。 */
  requestApproval(name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'>;
  /** 内核澄清回调面：clarify.request（request_id）→ clarify.respond {answer} */
  requestClarify(question: string, choices?: string[]): Promise<string>;
  /** 内核敏感输入面：secret.request/sudo.request（request_id）→ *.respond；空输入归一 null */
  requestSecretInput(kind: 'sudo' | 'secret', prompt: string, name?: string): Promise<string | null>;
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

  // ── 审批/澄清/密钥：内核回调 → hermes 请求事件 → TUI 面板 → *.respond → resolve ──
  // 语义对齐 src/cli/headlessGateway.ts（W2-03 supremacy 2.1：request_id 必须广播到事件流，
  // 否则外部前端无从应答）；无应答超时 fail-closed（deny/''/null——KF-010 同款绝不静默放行）。
  // approval 为 hermes 单槽协议（approval.request/respond 均不带 request_id）——respond 取
  // 最后插入项：agent 串行执行工具，同一时刻至多一个审批在等。
  const REQUEST_TIMEOUT_MS = Math.max(1_000, deps.requestTimeoutMs ?? 300_000);
  interface PendingApproval { resolve(choice: 'allow' | 'session' | 'deny'): void; timer: NodeJS.Timeout }
  interface PendingText { resolve(v: string): void; timer: NodeJS.Timeout; kind: 'clarify' | 'secret' | 'sudo' }
  const pendingApprovals = new Map<string, PendingApproval>();
  const pendingTexts = new Map<string, PendingText>();

  const settleApproval = (rid: string, choice: 'allow' | 'session' | 'deny') => {
    const p = pendingApprovals.get(rid);
    if (!p) return false;
    pendingApprovals.delete(rid); clearTimeout(p.timer); p.resolve(choice); return true;
  };
  const settleText = (rid: string, v: string) => {
    const p = pendingTexts.get(rid);
    if (!p) return false;
    pendingTexts.delete(rid); clearTimeout(p.timer); p.resolve(v); return true;
  };
  // 未应答请求全部 fail-closed 释放（回合结束残留/网关关闭）：
  // sudo/secret 有协议 expire 事件（TUI 关面板）；approval/clarify 无——用户事后 respond 时
  // handled:false 但 ok:true，TUI done() 仍会关面板。
  const failClosePending = (reason: string) => {
    let dropped = 0;
    for (const rid of [...pendingApprovals.keys()]) if (settleApproval(rid, 'deny')) dropped++;
    for (const [rid, p] of [...pendingTexts]) {
      if (!settleText(rid, '')) continue;
      dropped++;
      if (p.kind !== 'clarify') broadcast({ type: `${p.kind}.expire`, payload: { request_id: rid } });
    }
    if (dropped) broadcast({ type: 'notification.show', payload: { text: `${reason}：${dropped} 个未应答请求已取消（fail-closed）`, level: 'warn', ttl_ms: 8000 } });
  };
  // 审批对象摘要：bash/wx_cmd 显命令，文件工具显路径，其余显工具名
  const approvalSummary = (name: string, args: Record<string, unknown>) => {
    const cmd = typeof args?.command === 'string' && args.command ? args.command
      : typeof args?.path === 'string' && args.path ? String(args.path) : name;
    return String(cmd).slice(0, 200);
  };
  const requestApproval = (name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'> =>
    new Promise(resolve => {
      const rid = randomUUID();
      const timer = setTimeout(() => {
        if (settleApproval(rid, 'deny')) {
          broadcast({ type: 'notification.show', payload: { text: `审批超时已拒绝：${name}（面板选 deny 可关闭）`, level: 'warn', ttl_ms: 8000 } });
        }
      }, REQUEST_TIMEOUT_MS);
      pendingApprovals.set(rid, { resolve, timer });
      broadcast({
        type: 'approval.request',
        payload: { command: approvalSummary(name, args), description: `工具调用审批：${name}`, choices: ['once', 'session', 'always', 'deny'] },
      });
    });
  const requestClarify = (question: string, choices?: string[]): Promise<string> =>
    new Promise(resolve => {
      const rid = randomUUID();
      const timer = setTimeout(() => {
        if (settleText(rid, '')) broadcast({ type: 'notification.show', payload: { text: '澄清超时（空答案继续）', level: 'warn', ttl_ms: 8000 } });
      }, REQUEST_TIMEOUT_MS);
      pendingTexts.set(rid, { resolve, timer, kind: 'clarify' });
      broadcast({ type: 'clarify.request', payload: { request_id: rid, question: String(question ?? ''), choices: choices?.length ? choices : null } });
    });
  const requestSecretInput = (kind: 'sudo' | 'secret', prompt: string, name?: string): Promise<string | null> =>
    new Promise(resolve => {
      // 空输入归一 null（bridges onSecretRequest 语义：null=不可用，工具拒绝并提示）
      const done = (v: string) => resolve(v || null);
      const rid = randomUUID();
      const timer = setTimeout(() => {
        if (settleText(rid, '')) broadcast({ type: `${kind}.expire`, payload: { request_id: rid } });
      }, REQUEST_TIMEOUT_MS);
      pendingTexts.set(rid, { resolve: done, timer, kind });
      broadcast(kind === 'sudo'
        ? { type: 'sudo.request', payload: { request_id: rid } }
        : { type: 'secret.request', payload: { env_var: String(name ?? ''), prompt: String(prompt ?? ''), request_id: rid } });
    });

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
        // 回合结束：未应答的审批/澄清/密钥全部 fail-closed（中断/异常路径——正常路径 respond 已清空）
        failClosePending('回合结束');
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
    // —— 审批/澄清/密钥应答（UI → 内核）——hermes TUI 实测帧形状：
    //   approval.respond {choice:'once'|'session'|'always'|'deny', session_id}（单槽，无 request_id）
    //   clarify.respond {answer, request_id} · secret.respond {request_id, value} · sudo.respond {password, request_id}
    // handled:false = 该请求已超时/被取消（仍 ok——TUI done() 关面板，内核侧已 fail-closed）
    'approval.respond': p => {
      const raw = String(p?.choice ?? 'deny');
      const choice: 'allow' | 'session' | 'deny' = raw === 'session' ? 'session' : raw === 'once' || raw === 'always' ? 'allow' : 'deny';
      const rid = [...pendingApprovals.keys()].pop() ?? '';
      return { ok: true, handled: rid ? settleApproval(rid, choice) : false };
    },
    'clarify.respond': p => ({ ok: true, handled: settleText(String(p?.request_id ?? ''), String(p?.answer ?? '')) }),
    'secret.respond': p => ({ ok: true, handled: settleText(String(p?.request_id ?? ''), String(p?.value ?? '')) }),
    'sudo.respond': p => ({ ok: true, handled: settleText(String(p?.request_id ?? ''), String(p?.password ?? p?.value ?? '')) }),
    // —— hermes 特有彩蛋（桩——诚实空实现）——
    'pet.info.meta': () => ({ cells: null, meta: null, note: 'wxnodus：宠物面板未启用' }),
    'pet.cells': () => ({ cells: [] }),
    'pet.gallery': () => ({ gallery: [] }),
    'pet.select': () => ({ ok: true }),
    'image.detach': () => ({ ok: true }),
    'completion.complete': () => ({ items: [] }),
    'history.search': () => ({ results: [] }),
    // —— TUI 启动流程调用面（2026-08-29 空白屏修复补齐——此前「方法未实现」error 刷屏）——
    // 语音唤醒：wxnodus 无语音后端——诚实拒绝（TUI wake.ts 按 reason 展示提示）
    'wake.start': () => ({ started: false, reason: 'voice_unavailable', hint: 'wxnodus 未启用语音唤醒' }),
    // slash 命令目录：真实 registry（SLASH + 中文描述 → canon 映射）
    'commands.catalog': async () => {
      const { SLASH, COMMAND_DESC } = await import('../commands/registry.js');
      const canon: Record<string, string> = {};
      for (const cmd of SLASH) canon[cmd] = COMMAND_DESC[cmd] ?? '';
      return { canon, skill_count: 0 };
    },
    // 模型/密钥就绪检查：真实判定（有 baseURL 或已存密钥 = provider_configured）
    'setup.status': () => {
      const s = (deps.config.get('settings') ?? {}) as Record<string, unknown>;
      return { provider_configured: Boolean(s.apiKeyEnc || s.baseURL || s.model) };
    },
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
        requestApproval,
        requestClarify,
        requestSecretInput,
        close: () => new Promise<void>(done => {
          failClosePending('网关关闭');
          for (const off of offs) { try { off(); } catch { /* 已退订 */ } }
          for (const ws of clients) { try { ws.close(); } catch { /* 已关闭 */ } }
          wss.close(() => server.close(() => done()));
        }),
      });
    });
  });
}
