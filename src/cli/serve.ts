// src/cli/serve.ts — AI 网关（P0-01：Bearer 认证 + 最小 /health/live + 严格预检 + CSRF + 结构化 body 上限）
// 路由：
//   GET  /health/live   最小存活探针（无认证、不泄漏 dataDir/cwd/model/统计）
//   GET  /health        完整状态（需 Bearer）
//   GET  /flow          管线流图可视化（静态零数据页，无认证；实时模式页内凭 token 走 /events）
//   POST /rpc           { method, params }——method 见 RpcMethods（需 Bearer；跨源被 CSRF 拒绝）
//   GET  /events        SSE 事件流（需 Bearer）
// 绑定 127.0.0.1（仅本机）；端口 WXNODUS_SERVE_PORT ?? 4789；token WXNODUS_SERVE_TOKEN（未配置时除 /health/live 外全部 401）
// 客户端示例：curl -s http://127.0.0.1:4789/health/live
//            curl -s -X POST http://127.0.0.1:4789/rpc -H "Authorization: Bearer <token>" \
//                 -H 'Content-Type: application/json' -d '{"method":"chat","params":{"prompt":"你好"}}'
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
// W3-01：RPC 响应状态走共享 completionTransport 映射（failure 不藏在 HTTP 200 后面）
import { httpStatusForCompletion } from '../protocol/completionTransport.js';
import { isRunIdentifier, isSessionIdentifier, type RunFinalStatus } from '../protocol/runs.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import type { RunInvocationHandle, RunInvocationPort } from '../application/runs/runInvocationPort.js';
import { resolveAlias } from '../kernel/commandLevels.js';
import { evaluateCsrf } from '../presentation/http/csrfPolicy.js';
import { renderFlowHtml, FLOW_CSP } from '../presentation/http/flowPage.js';
import { WXNODUS_VERSION } from '../kernel/version.js';

export interface ServeKernel {
  dataDir: string;
  cwd: string;
  db: {
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number } };
    transaction?(operation: (...args: any[]) => any): (...args: any[]) => any;
  };
  bus: { on(type: string, fn: (e: any) => void): () => void };
  runInvocation: RunInvocationPort;
  mem: {
    recallHybrid?(q: string, o?: { limit?: number; sessionId?: string }): Promise<Array<{ id: number; content: string; score: number; session_id?: string }>>;
    recall(sessionId: string): Array<{ id: number; role: string; content: string; ts: number }>;
  };
  agent: { run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; getSessionId?(): string; setSessionId?(id: string): void };
  commandBus: { execute(cmd: string, context?: { signal?: AbortSignal }): Promise<{ ok: boolean; output?: string; error?: string; completionStatus?: RunFinalStatus }> };
  config: { get(p: string): Record<string, any> };
  /** W3 MCP facade：incoming Streamable HTTP handler（/mcp 挂载；Bearer/CSRF 前置后委托 SDK handler） */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface ServeSessionOwnershipStore {
  ownerOf(sessionId: string): { principalId: string; isDefault: boolean } | undefined;
  defaultFor(principalId: string): string | undefined;
  claim(principalId: string, sessionId: string): boolean;
  setDefault(principalId: string, sessionId: string): boolean;
  ownedSessionIds(principalId: string): Set<string>;
}

export function createInMemoryServeSessionOwnershipStore(): ServeSessionOwnershipStore {
  const ownership = new Map<string, { principalId: string; isDefault: boolean }>();
  const claim = (principalId: string, sessionId: string) => {
    const owner = ownership.get(sessionId);
    if (owner) return owner.principalId === principalId;
    ownership.set(sessionId, { principalId, isDefault: false });
    return true;
  };
  return {
    ownerOf: sessionId => ownership.get(sessionId),
    defaultFor: principalId => [...ownership].find(([, owner]) => owner.principalId === principalId && owner.isDefault)?.[0],
    claim,
    setDefault(principalId, sessionId) {
      if (!claim(principalId, sessionId)) return false;
      for (const owner of ownership.values()) {
        if (owner.principalId === principalId) owner.isDefault = false;
      }
      ownership.get(sessionId)!.isDefault = true;
      return true;
    },
    ownedSessionIds: principalId => new Set([...ownership]
      .filter(([, owner]) => owner.principalId === principalId)
      .map(([sessionId]) => sessionId)),
  };
}

export interface ServeSecurityOptions {
  /** Legacy Bearer token, always mapped to stable principal `serve:local`. */
  token?: string;
  /**
   * A-S1（2026-08-28）SDK 握手模式：token 改为随机生成（忽略 env——不落盘不进环境变量），
   * 监听就绪后经 onSdkHandshake 回传握手信息（单行 JSON 由调用方写 stdout——
   * 父进程管道私有性即安全边界）。端口传 0 = 随机可用端口。
   */
  sdkHandshake?: boolean;
  /** SDK 握手回调（listening 后恰一次；cli 层负责写 stdout） */
  onSdkHandshake?: (info: { port: number; token: string; pid: number; version: string; protocolVersion: number }) => void;
  /** Runtime-only stable principal IDs mapped to plaintext bearer tokens. Tokens are never persisted. */
  principals?: Readonly<Record<string, string>>;
  /** CORS origin allowlist（默认 WXNODUS_SERVE_ORIGINS 逗号分隔） */
  originAllowlist?: string[];
  /** 请求体上限字节（默认 1MB） */
  maxBodyBytes?: number;
  /** Completed idempotency replay lifetime. */
  idempotencyTtlMs?: number;
  /** Explicit ownership store for narrow adapters; production defaults to strict SQLite. */
  ownershipStore?: ServeSessionOwnershipStore;
  /** Completed Run ownership replay lifetime used for SSE authorization. */
  runOwnerTtlMs?: number;
  /** Maximum completed Run ownership entries retained; active/queued Runs are never evicted. */
  runOwnerLimit?: number;
  /** Time allowed for admitted requests/runs to finish before cancellation. */
  shutdownGraceMs?: number;
  /** Time allowed for cancelled invocations to reach terminal settlement. */
  shutdownForceMs?: number;
}

const BODY_TOO_LARGE = 1_000_000;

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; code: 'HTTP_REQUEST_BODY_TOO_LARGE' }> {
  return new Promise((resolve, reject) => {
    // V4 P1-4：Buffer 数组聚合，end 时整体 concat 解码——此前 `data += chunk` 逐块隐式
    // toString('utf8')，中文等多字节序列被 TCP 分包边界截断即产不可逆 U+FFFD（长中文
    // prompt 高概率损坏）。字节累计限流语义不变。
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      // 超限后继续排空流（不累积、不 destroy——让服务端能写出 413 响应）
      if (!overflow) {
        chunks.push(chunk);
        received += chunk.length;
        if (received > maxBytes) overflow = true;
      }
    });
    req.on('end', () => resolve(overflow ? { ok: false, code: 'HTTP_REQUEST_BODY_TOO_LARGE' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') }));
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
  // A-S1：SDK 握手模式——随机 token（覆盖 env/显式 token：SDK 会话凭据一次性，绝不落盘）
  const legacyToken = opts.sdkHandshake === true
    ? randomBytes(24).toString('base64url')
    : (opts.token ?? process.env.WXNODUS_SERVE_TOKEN ?? '');
  const principalTokens = new Map<string, string>();
  for (const [principalId, principalToken] of Object.entries(opts.principals ?? {})) {
    if (!principalId.trim() || !principalToken) continue;
    principalTokens.set(principalId, principalToken);
  }
  if (legacyToken) principalTokens.set('serve:local', legacyToken);
  const allowlist = opts.originAllowlist
    ?? (process.env.WXNODUS_SERVE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const maxBodyBytes = opts.maxBodyBytes ?? BODY_TOO_LARGE;
  const idempotencyTtlMs = Math.max(1_000, opts.idempotencyTtlMs ?? 5 * 60_000);
  const runOwnerTtlMs = Math.max(0, opts.runOwnerTtlMs ?? idempotencyTtlMs);
  const runOwnerLimit = Math.max(0, Math.floor(opts.runOwnerLimit ?? 4096));
  const shutdownGraceMs = Math.max(0, opts.shutdownGraceMs ?? 5_000);
  const shutdownForceMs = Math.max(0, opts.shutdownForceMs ?? 2_000);

  const ownershipStoreFailure = (): Error => Object.assign(
    new Error('SERVE_OWNERSHIP_STORE_FAILED'),
    { code: 'SERVE_OWNERSHIP_STORE_FAILED' },
  );
  const sqliteOwnershipStore: ServeSessionOwnershipStore = {
    ownerOf(sessionId) {
      try {
        const row = k.db.prepare('SELECT principal_id, is_default FROM serve_session_ownership WHERE session_id=?').get(sessionId) as { principal_id?: string; is_default?: number } | undefined;
        return typeof row?.principal_id === 'string'
          ? { principalId: row.principal_id, isDefault: Number(row.is_default ?? 0) === 1 }
          : undefined;
      } catch { throw ownershipStoreFailure(); }
    },
    defaultFor(principalId) {
      try {
        const row = k.db.prepare('SELECT session_id FROM serve_session_ownership WHERE principal_id=? AND is_default=1 LIMIT 1').get(principalId) as { session_id?: string } | undefined;
        return typeof row?.session_id === 'string' ? row.session_id : undefined;
      } catch { throw ownershipStoreFailure(); }
    },
    claim(principalId, sessionId) {
      try {
        k.db.prepare('INSERT OR IGNORE INTO serve_session_ownership(session_id, principal_id, is_default, claimed_at) VALUES (?, ?, 0, ?)')
          .run(sessionId, principalId, Date.now());
        return this.ownerOf(sessionId)?.principalId === principalId;
      } catch { throw ownershipStoreFailure(); }
    },
    setDefault(principalId, sessionId) {
      try {
        if (!k.db.transaction) throw ownershipStoreFailure();
        const commit = k.db.transaction((targetPrincipalId: string, targetSessionId: string) => {
          k.db.prepare('INSERT OR IGNORE INTO serve_session_ownership(session_id, principal_id, is_default, claimed_at) VALUES (?, ?, 0, ?)')
            .run(targetSessionId, targetPrincipalId, Date.now());
          const owner = k.db.prepare('SELECT principal_id FROM serve_session_ownership WHERE session_id=?')
            .get(targetSessionId) as { principal_id?: string } | undefined;
          if (owner?.principal_id !== targetPrincipalId) return false;
          k.db.prepare('UPDATE serve_session_ownership SET is_default=0 WHERE principal_id=? AND is_default=1')
            .run(targetPrincipalId);
          return k.db.prepare('UPDATE serve_session_ownership SET is_default=1 WHERE session_id=? AND principal_id=?')
            .run(targetSessionId, targetPrincipalId).changes === 1;
        });
        return commit(principalId, sessionId);
      } catch { throw ownershipStoreFailure(); }
    },
    ownedSessionIds(principalId) {
      try {
        const rows = k.db.prepare('SELECT session_id FROM serve_session_ownership WHERE principal_id=?').all(principalId) as Array<{ session_id?: string }>;
        return new Set(rows.flatMap(row => typeof row.session_id === 'string' ? [row.session_id] : []));
      } catch { throw ownershipStoreFailure(); }
    },
  };
  const ownershipStore = opts.ownershipStore ?? sqliteOwnershipStore;
  const initialSessionFor = (principalId: string): string => {
    const existing = ownershipStore.defaultFor(principalId);
    if (existing) return existing;
    const candidate = principalId === 'serve:local'
      ? (k.agent.getSessionId?.() ?? 'default')
      : `serve-${createHash('sha256').update(principalId).digest('hex').slice(0, 16)}`;
    return candidate;
  };
  type SessionAuthorization = { ok: true; sessionId: string } | { ok: false; code: 'SESSION_ID_INVALID' | 'SESSION_FORBIDDEN' | 'SERVE_OWNERSHIP_STORE_FAILED' };
  const authorizeSession = (principalId: string, requested?: unknown): SessionAuthorization => {
    try {
      const sessionId = requested === undefined || requested === null || requested === ''
        ? initialSessionFor(principalId)
        : String(requested);
      if (!isSessionIdentifier(sessionId)) return { ok: false, code: 'SESSION_ID_INVALID' };
      if (!ownershipStore.claim(principalId, sessionId)) return { ok: false, code: 'SESSION_FORBIDDEN' };
      if (!ownershipStore.defaultFor(principalId) && !ownershipStore.setDefault(principalId, sessionId)) {
        return { ok: false, code: 'SERVE_OWNERSHIP_STORE_FAILED' };
      }
      return { ok: true, sessionId };
    } catch {
      return { ok: false, code: 'SERVE_OWNERSHIP_STORE_FAILED' };
    }
  };
  const sessionFailure = (authorization: Extract<SessionAuthorization, { ok: false }>): CachedResponse => ({
    status: authorization.code === 'SESSION_ID_INVALID' ? 400 : authorization.code === 'SESSION_FORBIDDEN' ? 403 : 500,
    body: { ok: false, error: { code: authorization.code } },
  });
  const ownershipFailureResponse = (): CachedResponse => ({
    status: 500,
    body: { ok: false, error: { code: 'SERVE_OWNERSHIP_STORE_FAILED' } },
  });
  const setDefaultSession = (principalId: string, sessionId: string): boolean => {
    try { return ownershipStore.setDefault(principalId, sessionId); }
    catch { throw ownershipStoreFailure(); }
  };
  const ownedSessionIds = (principalId: string): Set<string> => {
    try { return ownershipStore.ownedSessionIds(principalId); }
    catch { throw ownershipStoreFailure(); }
  };
  type CommandAuthorization = { ok: true; command: string } | { ok: false; response: CachedResponse };
  const commandForbidden = (): CommandAuthorization => ({
    ok: false,
    response: { status: 403, body: { ok: false, error: { code: 'SERVE_COMMAND_FORBIDDEN' } } },
  });
  const authorizeServeCommand = (principalId: string, input: string): CommandAuthorization => {
    const trimmed = input.trim();
    const tokens = trimmed.split(/\s+/);
    const rawHead = tokens[0] ?? '';
    if (rawHead.includes(':')) return commandForbidden();
    const commandName = resolveAlias(rawHead).toLowerCase();
    if (commandName === '/status' && tokens.length === 1) return { ok: true, command: '/status' };
    if (commandName === '/new' && tokens.length === 1) return { ok: true, command: '/new' };
    if (commandName !== '/resume' || tokens.length < 2) return commandForbidden();
    const query = tokens.slice(1).join(' ');
    const rows = k.db.prepare('SELECT id, title FROM sessions ORDER BY updated_at DESC').all() as Array<{ id?: unknown; title?: unknown }>;
    const exact = rows.find(row => row.id === query);
    const resolved = exact ?? rows.find(row => String(row.title ?? '').toLowerCase().includes(query.toLowerCase()));
    const target = typeof resolved?.id === 'string' ? resolved.id : query;
    const authorization = authorizeSession(principalId, target);
    if (!authorization.ok) return { ok: false, response: sessionFailure(authorization) };
    return { ok: true, command: `/resume ${authorization.sessionId}` };
  };

  const createDisconnectController = (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    if (req.aborted || res.destroyed || res.closed) abort();
    return {
      signal: controller.signal,
      dispose() {
        req.off('aborted', abort);
        res.off('close', abort);
      },
    };
  };
  const canRespond = (res: ServerResponse) => !res.destroyed && !res.writableEnded;
  let closing = false;
  const activeInvocations = new Set<RunInvocationHandle<unknown>>();
  const activeRequests = new Set<Promise<void>>();
  type RunOwner = { principalId: string; sessionId: string; runId: string; active: boolean; expiresAt: number };
  const runOwners = new Map<string, RunOwner>();
  const runOwnerKey = (principalId: string, runId: string) => `${principalId}\u0000${runId}`;
  const pruneRunOwners = () => {
    const now = Date.now();
    for (const [key, owner] of runOwners) {
      if (!owner.active && owner.expiresAt <= now) runOwners.delete(key);
    }
    let completed = [...runOwners].filter(([, owner]) => !owner.active);
    while (completed.length > runOwnerLimit) {
      const [oldestKey] = completed.shift()!;
      runOwners.delete(oldestKey);
    }
  };
  const runOwnerOf = (principalId: string, runId: string): RunOwner | undefined => {
    pruneRunOwners();
    return runOwners.get(runOwnerKey(principalId, runId));
  };
  const publishRunOwner = <T>(handle: RunInvocationHandle<T>, principalId: string, sessionId: string): RunInvocationHandle<T> => {
    const runId = handle.context.runId;
    const key = runOwnerKey(principalId, runId);
    runOwners.set(key, { principalId, sessionId, runId, active: true, expiresAt: Number.POSITIVE_INFINITY });
    const complete = () => {
      const owner = runOwners.get(key);
      if (!owner) return;
      owner.active = false;
      owner.expiresAt = Date.now() + runOwnerTtlMs;
      pruneRunOwners();
    };
    void handle.completion.then(complete, complete);
    return handle;
  };
  type CachedResponse = { status: number; body: unknown };
  type IdempotencyEntry = { digest: string; expiresAt: number; completion: Promise<CachedResponse> };
  const idempotency = new Map<string, IdempotencyEntry>();
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  };
  const requestDigest = (method: string, params: Record<string, unknown>) => createHash('sha256')
    .update(JSON.stringify(canonicalize({ method, params })))
    .digest('hex');
  const pruneIdempotency = () => {
    const now = Date.now();
    for (const [key, entry] of idempotency) {
      if (entry.expiresAt <= now) idempotency.delete(key);
    }
  };
  const trackInvocation = <T>(handle: RunInvocationHandle<T>): RunInvocationHandle<T> => {
    const tracked = handle as RunInvocationHandle<unknown>;
    activeInvocations.add(tracked);
    const forget = () => activeInvocations.delete(tracked);
    void handle.completion.then(forget, forget);
    return handle;
  };
  const rejectIfClosing = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!closing) return false;
    if (canRespond(res)) {
      json(res, req, 503, { ok: false, error: { code: 'HTTP_SERVER_CLOSING' } }, allowlist);
    }
    return true;
  };

  // supremacy 2.5：SSE 订阅者注册表 + 会话变更广播——桌面端/面板经 /events 订阅，
  // /rpc（chat/command）变更会话后实时收到 session.changed（协议见 docs/serve-protocol.md）
  type SseIdentity = { runId?: string; correlationId?: string; sessionId?: string; actorId?: string };
  type SseClient = { res: ServerResponse; principalId: string; filter: SseIdentity; close(): void };
  const sseClients = new Set<SseClient>();
  const matchesFilter = (filter: SseIdentity, identity: SseIdentity) =>
    (!filter.runId || filter.runId === identity.runId)
    && (!filter.correlationId || filter.correlationId === identity.correlationId)
    && (!filter.sessionId || filter.sessionId === identity.sessionId);
  const eventData = (payload: unknown, identity: SseIdentity) => ({
    ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload }),
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.correlationId ? { correlationId: identity.correlationId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
  });
  const writeSse = (client: SseClient, type: string, data: string): boolean => {
    try {
      if (!client.res.write(`event: ${type}\ndata: ${data}\n\n`)) {
        client.close();
        return false;
      }
      return true;
    } catch {
      client.close();
      return false;
    }
  };
  const admittedIdentity = (principalId: string, identity: SseIdentity): (SseIdentity & { principalId: string }) | undefined => {
    if (!identity.runId || (identity.actorId && identity.actorId !== principalId)) return undefined;
    const owner = runOwnerOf(principalId, identity.runId);
    if (!owner) return undefined;
    return {
      runId: identity.runId,
      correlationId: identity.correlationId,
      sessionId: owner.sessionId,
      principalId: owner.principalId,
    };
  };
  const broadcast = (principalId: string, type: string, payload: unknown, identity: SseIdentity = {}) => {
    const admitted = admittedIdentity(principalId, identity);
    if (!admitted) return;
    const data = JSON.stringify(eventData(payload, admitted));
    for (const client of [...sseClients]) {
      if (admitted.principalId !== client.principalId) continue;
      if (!matchesFilter(client.filter, admitted)) continue;
      writeSse(client, type, data);
    }
  };

  const bearerOf = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  };

  const authenticate = (req: IncomingMessage): string | null => {
    const bearer = bearerOf(req);
    if (bearer === null) return null;
    for (const [principalId, expected] of principalTokens) {
      if (safeTokenCompare(Buffer.from(bearer), expected)) return principalId;
    }
    return null;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const csrf = evaluateCsrf({
      method: req.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : value])),
      originAllowlist: allowlist,
    });

    try {
      if (rejectIfClosing(req, res)) return;
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
        if (authenticate(req) === null) {
          json(res, req, 401, { ok: false, error: { code: 'HTTP_TOKEN_MISSING' } }, allowlist);
          return;
        }
        res.writeHead(204, corsHeaders(req, allowlist));
        res.end();
        return;
      }

      // 最小存活探针：无认证、零泄漏
      if (req.method === 'GET' && url.pathname === '/health/live') {
        json(res, req, 200, { ok: true, service: 'wxnodus-serve', version: WXNODUS_VERSION }, allowlist);
        return;
      }

      // 管线流图可视化：纯静态零数据页（无认证、不注入任何请求参数）；实时模式由页面内
      // 凭用户输入的 token 经同源 fetch 流式读取 /events——网关认证面不变
      if (req.method === 'GET' && url.pathname === '/flow') {
        const html = renderFlowHtml({ version: WXNODUS_VERSION });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': FLOW_CSP,
          'Cache-Control': 'no-store',
          ...corsHeaders(req, allowlist),
        });
        res.end(html);
        return;
      }

      // 状态修改请求：跨源 CSRF 判定先于认证（跨源携带有效 token 也拒绝）
      if (!csrf.ok) {
        json(res, req, 403, { ok: false, error: { code: csrf.code } }, allowlist);
        return;
      }

      // 除 /health/live 外全部 Bearer 认证
      const principalId = authenticate(req);
      if (principalId === null) {
        json(res, req, 401, { ok: false, error: { code: 'HTTP_TOKEN_MISSING' } }, allowlist);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        let cmdCount = 0;
        try { cmdCount = (k.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c; } catch { /* 内存模式 */ }
        json(res, req, 200, {
          ok: true, service: 'wxnodus-serve', version: WXNODUS_VERSION,
          model: (k.config.get('settings') as any)?.model ?? '',
          dataDir: k.dataDir, cwd: k.cwd,
          messages: cmdCount,
        }, allowlist);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        const filter = {
          runId: url.searchParams.get('run_id') ?? undefined,
          correlationId: url.searchParams.get('correlation_id') ?? undefined,
          sessionId: url.searchParams.get('session_id') ?? undefined,
        };
        if ((filter.runId !== undefined && !isRunIdentifier(filter.runId))
          || (filter.correlationId !== undefined && !isRunIdentifier(filter.correlationId))
          || (filter.sessionId !== undefined && !isSessionIdentifier(filter.sessionId))) {
          json(res, req, 400, { ok: false, error: { code: 'RUN_FILTER_INVALID' } }, allowlist);
          return;
        }
        if (!filter.runId && !filter.sessionId) {
          json(res, req, filter.correlationId ? 403 : 400, { ok: false, error: { code: filter.correlationId ? 'SSE_NOT_AUTHORIZED' : 'SSE_FILTER_REQUIRED' } }, allowlist);
          return;
        }
        if (filter.runId) {
          const runOwner = runOwnerOf(principalId, filter.runId);
          if (!runOwner) {
            json(res, req, 403, { ok: false, error: { code: 'SSE_NOT_AUTHORIZED' } }, allowlist);
            return;
          }
        }
        if (filter.sessionId) {
          const authorization = authorizeSession(principalId, filter.sessionId);
          if (!authorization.ok) {
            const failure = sessionFailure(authorization);
            json(res, req, failure.status, failure.body, allowlist);
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const offs: Array<() => void> = [];
        let cleaned = false;
        let client: SseClient;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          req.off('close', cleanup);
          sseClients.delete(client);
          for (const off of offs) { try { off(); } catch {} }
          if (canRespond(res)) res.end();
        };
        client = { res, principalId, filter, close: cleanup };
        sseClients.add(client);
        if (!writeSse(client, 'ready', JSON.stringify({ connected: true }))) return;
        for (const type of ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'run.final', 'system.notice', 'voice.transcript']) {
          offs.push(k.bus.on(type, (e: any) => {
            const identity = admittedIdentity(principalId, {
              runId: e?.runId,
              correlationId: e?.correlationId,
              sessionId: e?.sessionId,
              actorId: e?.actorId,
            });
            if (!identity) return;
            if (!matchesFilter(filter, identity)) return;
            writeSse(client, type, JSON.stringify(eventData(e?.payload ?? {}, identity)));
          }));
        }
        req.once('close', cleanup);
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
        if (rejectIfClosing(req, res)) return;
        if (!bodyResult.ok) {
          json(res, req, 413, { ok: false, error: { code: bodyResult.code } }, allowlist);
          return;
        }
        const body = JSON.parse(bodyResult.text || '{}') as { method?: string; params?: Record<string, any> };
        const method = String(body.method ?? '');
        const params = (body.params ?? {}) as Record<string, any>;
        const sendCached = (response: CachedResponse) => {
          if (canRespond(res)) json(res, req, response.status, response.body, allowlist);
        };
        const runIdempotent = async (
          operation: (sessionId: string, runId: string) => Promise<CachedResponse>,
        ): Promise<CachedResponse> => {
          const rawRequestId = params.request_id ?? params.run_id;
          if (rawRequestId === undefined || rawRequestId === null || String(rawRequestId) === '') {
            return { status: 400, body: { ok: false, error: { code: 'REQUEST_ID_REQUIRED' } } };
          }
          const requestId = String(rawRequestId);
          if (!isRunIdentifier(requestId)) {
            const code = params.request_id === undefined ? 'RUN_ID_INVALID' : 'REQUEST_ID_INVALID';
            return { status: 400, body: { ok: false, error: { code } } };
          }
          const authorized = authorizeSession(principalId, params.session_id);
          if (!authorized.ok) return sessionFailure(authorized);
          pruneIdempotency();
          const key = `${principalId}\u0000${requestId}`;
          const digest = requestDigest(method, params);
          const existing = idempotency.get(key);
          if (existing) {
            if (existing.digest !== digest) {
              return { status: 409, body: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } } };
            }
            return existing.completion;
          }
          const requestedRunId = params.run_id === undefined ? requestId : String(params.run_id);
          const completion = operation(authorized.sessionId, requestedRunId);
          const entry: IdempotencyEntry = { digest, expiresAt: Number.POSITIVE_INFINITY, completion };
          idempotency.set(key, entry);
          void completion.finally(() => { entry.expiresAt = Date.now() + idempotencyTtlMs; });
          return completion;
        };
        switch (method) {
          case 'chat': {
            const prompt = String(params.prompt ?? '');
            if (!prompt.trim()) { json(res, req, 400, { ok: false, error: 'prompt 必填' }, allowlist); return; }
            const response = await runIdempotent(async (sessionId, runId) => {
              const disconnect = createDisconnectController(req, res);
              let handle: RunInvocationHandle<any>;
              try {
                const occupied = runOwnerOf(principalId, runId);
                if (occupied) {
                  return { status: 409, body: { ok: false, error: { code: 'RUN_ID_CONFLICT' } } };
                }
                const admissionId = `serve:${createHash('sha256').update(`${principalId}\u0000${runId}`).digest('hex')}`;
                handle = trackInvocation(publishRunOwner(k.runInvocation.invoke({
                  kind: 'agent',
                  prompt,
                  runId,
                  admissionId,
                  correlationId: params.correlation_id === undefined ? undefined : String(params.correlation_id),
                  sessionId,
                  actorId: principalId,
                  source: 'http',
                  signal: disconnect.signal,
                  beforeRelease: coordinated => {
                    broadcast(principalId, 'session.changed', { reason: 'chat', ts: Date.now() }, coordinated.context);
                  },
                }), principalId, sessionId));
              } catch (cause) {
                disconnect.dispose();
                const code = (cause as { code?: string }).code ?? String((cause as Error).message ?? cause);
                return { status: code === 'RUN_ID_CONFLICT' ? 409 : 400, body: { ok: false, error: { code } } };
              }
              try {
                const run = await handle.completion;
                const result = run.value;
                const context = handle.context;
                return {
                  status: httpStatusForCompletion(run.status),
                  body: {
                    ok: run.status === 'succeeded',
                    status: run.status,
                    runId: context.runId,
                    correlationId: context.correlationId,
                    sessionId: context.sessionId,
                    text: result?.text ?? '',
                    turns: result?.turns ?? 0,
                    interrupted: run.status === 'cancelled' || result?.interrupted === true,
                    ...(run.error ? { error: run.error } : {}),
                  },
                };
              } catch (cause) {
                const code = (cause as { code?: string }).code;
                return { status: code === 'RUN_ID_CONFLICT' ? 409 : 500, body: { ok: false, error: { code: code ?? 'RUN_COORDINATOR_FAILED' } } };
              } finally {
                disconnect.dispose();
              }
            });
            sendCached(response);
            return;
          }
          case 'command': {
            const rawCommand = String(params.command ?? '');
            if (!rawCommand.trim()) { json(res, req, 400, { ok: false, error: 'command 必填' }, allowlist); return; }
            let commandAuthorization: CommandAuthorization;
            try {
              commandAuthorization = authorizeServeCommand(principalId, rawCommand);
            } catch {
              commandAuthorization = { ok: false, response: ownershipFailureResponse() };
            }
            if (!commandAuthorization.ok) {
              sendCached(commandAuthorization.response);
              return;
            }
            const cmd = commandAuthorization.command;
            const response = await runIdempotent(async (sessionId, runId) => {
              const disconnect = createDisconnectController(req, res);
              let handle: RunInvocationHandle<any>;
              try {
                const occupied = runOwnerOf(principalId, runId);
                if (occupied) {
                  return { status: 409, body: { ok: false, error: { code: 'RUN_ID_CONFLICT' } } };
                }
                const admissionId = `serve:${createHash('sha256').update(`${principalId}\u0000${runId}`).digest('hex')}`;
                handle = trackInvocation(publishRunOwner(k.runInvocation.invoke({
                  kind: 'command',
                  command: cmd,
                  runId,
                  admissionId,
                  correlationId: params.correlation_id === undefined ? undefined : String(params.correlation_id),
                  sessionId,
                  actorId: principalId,
                  source: 'http',
                  signal: disconnect.signal,
                  beforeFinalize: coordinated => {
                    const activeSessionId = coordinated.activeSessionId ?? coordinated.context.sessionId;
                    if ((/^\/resume(?:\s|$)/i.test(cmd) || cmd === '/new') && !setDefaultSession(principalId, activeSessionId)) {
                      throw Object.assign(new Error('SERVE_OWNERSHIP_STORE_FAILED'), { code: 'SERVE_OWNERSHIP_STORE_FAILED' });
                    }
                  },
                  beforeRelease: coordinated => {
                    const activeSessionId = coordinated.activeSessionId ?? coordinated.context.sessionId;
                    if (coordinated.status === 'succeeded') {
                      broadcast(principalId, 'session.changed', { activeSessionId, reason: 'command', ts: Date.now() }, coordinated.context);
                    }
                  },
                }), principalId, sessionId));
              } catch (cause) {
                disconnect.dispose();
                const code = (cause as { code?: string }).code ?? String((cause as Error).message ?? cause);
                return { status: code === 'RUN_ID_CONFLICT' ? 409 : 400, body: { ok: false, error: { code } } };
              }
              try {
                const run = await handle.completion;
                const result = run.value;
                const context = handle.context;
                const activeSessionId = run.activeSessionId ?? context.sessionId;
                return {
                  status: run.error === 'SERVE_OWNERSHIP_STORE_FAILED'
                    ? 500
                    : httpStatusForCompletion(run.status),
                  body: {
                    ok: run.status === 'succeeded',
                    status: run.status,
                    runId: context.runId,
                    correlationId: context.correlationId,
                    sessionId: context.sessionId,
                    activeSessionId,
                    output: result?.output ?? '',
                    error: run.error ?? result?.error,
                  },
                };
              } catch (cause) {
                const code = (cause as { code?: string }).code;
                return { status: code === 'RUN_ID_CONFLICT' ? 409 : 500, body: { ok: false, error: { code: code ?? 'RUN_COORDINATOR_FAILED' } } };
              } finally {
                disconnect.dispose();
              }
            });
            sendCached(response);
            return;
          }
          case 'memory.search': {
            const authorized = authorizeSession(principalId, params.session_id);
            if (!authorized.ok) {
              const failure = sessionFailure(authorized);
              json(res, req, failure.status, failure.body, allowlist);
              return;
            }
            if (!k.mem.recallHybrid) { json(res, req, 200, { ok: true, hits: [] }, allowlist); return; }
            const hits = await k.mem.recallHybrid(String(params.query ?? ''), {
              limit: Number(params.limit ?? 5),
              sessionId: authorized.sessionId,
            });
            json(res, req, 200, { ok: true, hits }, allowlist);
            return;
          }
          case 'memory.recall': {
            const authorized = authorizeSession(principalId, params.session_id);
            if (!authorized.ok) {
              const failure = sessionFailure(authorized);
              json(res, req, failure.status, failure.body, allowlist);
              return;
            }
            const rows = k.mem.recall(authorized.sessionId);
            json(res, req, 200, { ok: true, messages: rows }, allowlist);
            return;
          }
          case 'sessions': {
            // supremacy 2.5：结构化会话列表（与 /sessions --json、桌面端共用 listSessionsStructured
            // 单一事实源——首问摘要/消息数/分支数/血缘）；窄端口（测试桩/内存模式）回退裸 SQL 诚实降级
            let rows: unknown[] = [];
            try {
              const { listSessionsStructured } = await import('../kernel/sessionLineage.js');
              rows = listSessionsStructured(k.db as import('../store/db.js').Db);
            } catch {
              try {
                rows = k.db.prepare('SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50').all() as unknown[];
              } catch { /* 内存模式 */ }
            }
            const owned = ownedSessionIds(principalId);
            rows = rows.filter(row => {
              if (!row || typeof row !== 'object') return false;
              const id = (row as { id?: unknown }).id;
              return typeof id === 'string' && owned.has(id);
            });
            json(res, req, 200, { ok: true, sessions: rows }, allowlist);
            return;
          }
          default:
            json(res, req, 400, { ok: false, error: `未知 method：${method}（支持 chat/command/memory.search/memory.recall/sessions）` }, allowlist);
        }
        return;
      }

      json(res, req, 404, { ok: false, error: `未找到路由：${req.method} ${url.pathname}（GET /health/live、GET /health、GET /flow、POST /rpc、GET /events）` }, allowlist);
    } catch (e: any) {
      if (canRespond(res)) {
        if (e?.code === 'SERVE_OWNERSHIP_STORE_FAILED' || e?.message === 'SERVE_OWNERSHIP_STORE_FAILED') {
          const failure = ownershipFailureResponse();
          json(res, req, failure.status, failure.body, allowlist);
        } else {
          json(res, req, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) }, allowlist);
        }
      }
    }
  };

  const server = createServer((req, res) => {
    const completion = handleRequest(req, res);
    activeRequests.add(completion);
    const forget = () => activeRequests.delete(completion);
    void completion.then(forget, forget);
  });

  const waitBounded = async (operation: Promise<unknown>, timeoutMs: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      operation,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]).catch(() => undefined);
    if (timer) clearTimeout(timer);
  };

  const waitForRequestDrain = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    await new Promise<void>(resolve => setImmediate(resolve));
    while (activeRequests.size > 0 && Date.now() < deadline) {
      await waitBounded(Promise.allSettled([...activeRequests]), Math.max(1, deadline - Date.now()));
    }
  };

  const waitForInvocationDrain = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    await new Promise<void>(resolve => setImmediate(resolve));
    while (activeInvocations.size > 0 && Date.now() < deadline) {
      await waitBounded(Promise.allSettled([...activeInvocations].map(handle => handle.completion)), Math.max(1, deadline - Date.now()));
    }
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;

    closing = true;
    const serverClosed = new Promise<void>(resolve => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
    server.closeIdleConnections?.();

    closePromise = (async () => {
      await waitForInvocationDrain(shutdownGraceMs);
      for (const handle of [...activeInvocations]) {
        try { handle.cancel(); } catch {}
      }
      await waitForInvocationDrain(shutdownForceMs);
      for (const client of [...sseClients]) client.close();
      await waitForRequestDrain(shutdownForceMs);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await waitBounded(serverClosed, shutdownForceMs);
    })();
    return closePromise;
  };

  // A-S1：SDK 握手（listening 后恰一次——真实端口/随机 token/PID/版本回传父进程）
  let listeningPort: number | null = null;
  server.listen(port, '127.0.0.1');
  if (opts.sdkHandshake === true && opts.onSdkHandshake) {
    server.once('listening', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      listeningPort = actualPort;
      try {
        opts.onSdkHandshake!({
          port: actualPort,
          token: legacyToken,
          pid: process.pid,
          version: WXNODUS_VERSION,
          protocolVersion: PROTOCOL_VERSION,
        });
      } catch { /* 握手回调异常不阻断服务 */ }
    });
  }
  return { get port() { return listeningPort ?? port; }, close };
}
