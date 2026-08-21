// src/kernel/a2a.ts — Agent-to-Agent 协议（A2A 规范：agent card + 任务流 + messages 快捷通道）
// 本地化为准：/a2a call 调用对端 agent；/a2a serve 启动本机 A2A 端点（127.0.0.1 监听）。
// 完整版（2026-08-19，阶段 3）：agent card（/.well-known/agent.json 能力/skills 声明）、
// 任务流（tasks/send → 状态轮询 tasks/get → tasks/cancel；pushNotificationConfig 状态推送）、
// stdio 行协议传输（a2aStdioServe——NDJSON 一行一帧）。诚实边界：任务注册表内存态（进程退出即清，
// 不做持久化——本地单机 A2A 无跨重启任务语义）；push 为 fire-and-forget（3s 超时，失败不阻断任务）。
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  asCancellableExecution,
  type CancellableOperation,
} from '../protocol/cancellableExecution.js';
import type { RunFinalStatus } from '../protocol/runs.js';

export interface A2AResponse {
  ok: boolean;
  text: string;
  messageId?: string;
  error?: string;
}

export interface A2ASkill { name: string; description?: string }

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  skills: A2ASkill[];
}

export interface A2AServeOptions {
  card?: { name: string; description: string; skills?: A2ASkill[] };
  /** V4 P0-7：本地监听 Bearer token——未配置时自动生成随机 token（调用方从返回值取回打印）。
   * 此前零认证：本机任意进程/浏览器恶意页面可用 CORS simple request 静默驱动任意 prompt
   * （对照同仓 --serve 的 Bearer+CSRF 三重防护——OpenCode 同型缺陷已酿 CVE-2026-22812）。 */
  token?: string;
}

interface OwnedExecution<T> {
  readonly completion: Promise<T>;
  cancel(): void;
}

interface A2ATask {
  id: string;
  state: 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';
  artifact?: { parts: Array<{ text: string }> };
  error?: string;
  pushUrl?: string;
  execution?: OwnedExecution<A2ARunResult>;
}

type A2ARunResult = {
  ok: boolean;
  text: string;
  status?: RunFinalStatus;
  error?: string;
};
type A2ARunner = (
  text: string,
  request: { sessionId: string },
) => CancellableOperation<A2ARunResult>;

let taskSeq = 0;
const nextTaskId = (): string => `t-${Date.now().toString(36)}${(++taskSeq).toString(36)}`;
const nextSessionId = (kind: 'message' | 'task'): string =>
  `a2a-${kind}-${randomUUID()}`;

const failedTaskState = (
  result: A2ARunResult,
): 'failed' | 'canceled' =>
  result.status === 'cancelled' ? 'canceled' : 'failed';

/** agent card 构建（纯函数可单测）：A2A 0.3.0 能力/skills 声明。 */
export const buildAgentCard = (opts: { name: string; description: string; url?: string; skills?: A2ASkill[]; pushNotifications?: boolean }): A2AAgentCard => ({
  protocolVersion: '0.3.0',
  name: opts.name,
  description: opts.description,
  url: opts.url,
  capabilities: { streaming: false, pushNotifications: opts.pushNotifications ?? false },
  skills: opts.skills ?? [],
});

const artifactOf = (r: A2ARunResult): A2ATask['artifact'] => ({
  parts: [{ text: r.text || (r.ok ? '（空回复）' : '模型未配置——/model set-key <密钥> 配置后使用') }],
});

/** 客户端：拉取对端 agent card（10s 超时；解析失败诚实报错）。 */
export async function fetchAgentCard(url: string): Promise<{ ok: boolean; card?: A2AAgentCard; error?: string }> {
  try {
    const base = url.endsWith('/') ? url : `${url}/`;
    const resp = await fetch(`${base}.well-known/agent.json`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const j = await resp.json() as A2AAgentCard;
    if (!j || typeof j.name !== 'string') return { ok: false, error: '卡片格式非法（缺 name）' };
    return { ok: true, card: j };
  } catch (e: any) {
    return { ok: false, error: `卡片拉取失败：${String(e?.message ?? e).slice(0, 160)}` };
  }
}

// 客户端：POST messages/send → 提取对端文本回复（快捷通道，保持既有契约）
export async function a2aCall(url: string, text: string, opts: { timeoutMs?: number; token?: string } = {}): Promise<A2AResponse> {
  const timeout = opts.timeoutMs ?? 120_000;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'messages/send',
        params: { message: { role: 'user', parts: [{ text }] } },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return { ok: false, text: '', error: `HTTP ${resp.status}` };
    const j = await resp.json() as any;
    const parts: Array<{ text?: string }> = j?.result?.message?.parts ?? [];
    const textOut = parts.map(p => p?.text ?? '').join('').trim();
    return { ok: !!textOut, text: textOut, messageId: j?.result?.message?.messageId, error: textOut ? undefined : '对端无文本回复' };
  } catch (e: any) {
    return { ok: false, text: '', error: `调用失败：${e?.message?.slice(0, 200) ?? e}` };
  }
}

/** 客户端：任务流（tasks/send → 轮询 tasks/get 至终态；超时诚实报错）。 */
export async function a2aTaskSend(
  url: string, text: string, opts: { timeoutMs?: number; pollMs?: number; pushUrl?: string; token?: string } = {},
): Promise<{ ok: boolean; text: string; taskId: string; state: string; error?: string }> {
  const timeout = opts.timeoutMs ?? 120_000;
  const poll = opts.pollMs ?? 100;
  try {
    const params: Record<string, unknown> = { message: { role: 'user', parts: [{ text }] } };
    if (opts.pushUrl) params.pushNotificationConfig = { url: opts.pushUrl };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return { ok: false, text: '', taskId: '', state: '', error: `HTTP ${resp.status}` };
    const j = await resp.json() as any;
    const taskId = j?.result?.id;
    if (!taskId) return { ok: false, text: '', taskId: '', state: '', error: '对端未返回任务 id' };
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const g = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: taskId } }),
        signal: AbortSignal.timeout(5000),
      });
      const gj = await g.json() as any;
      const state = gj?.result?.state;
      const parts: Array<{ text?: string }> = gj?.result?.artifact?.parts ?? [];
      const textOut = parts.map(p => p?.text ?? '').join('').trim();
      if (state === 'completed') return { ok: !!textOut, text: textOut, taskId, state, error: textOut ? undefined : '对端无文本回复' };
      if (state === 'failed') return { ok: false, text: '', taskId, state, error: gj?.result?.error ?? '任务失败' };
      if (state === 'canceled') return { ok: false, text: '', taskId, state, error: '任务已取消' };
      await new Promise(res => setTimeout(res, poll));
    }
    return { ok: false, text: '', taskId, state: 'timeout', error: `任务超时（${timeout}ms 未到终态）` };
  } catch (e: any) {
    return { ok: false, text: '', taskId: '', state: '', error: `任务调用失败：${e?.message?.slice(0, 200) ?? e}` };
  }
}

export interface A2AServer {
  url: string;
  /** V4 P0-7：本端点 Bearer token（自动生成或调用方传入）——调用方打印给用户，请求方凭此访问。 */
  token: string;
  stop(): Promise<void>;
}

/** 服务端：POST 处理 initialize/messages/send/tasks/*；GET /.well-known/agent.json 暴露卡片。 */
export async function a2aServe(
  port: number,
  run: A2ARunner,
  opts: A2AServeOptions = {},
): Promise<A2AServer> {
  const tasks = new Map<string, A2ATask>();
  const executions = new Set<OwnedExecution<A2ARunResult>>();
  let accepting = true;
  let stopping: Promise<void> | undefined;
  let serverUrl = '';
  // V4 P0-7：Bearer 认证——token 由调用方传入或自动生成（A2AServer.token 回传打印一次）
  const token = opts.token || randomBytes(24).toString('hex');
  const bearerOk = (req: import('node:http').IncomingMessage): boolean => {
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ')) return false;
    const given = Buffer.from(auth.slice(7));
    const want = Buffer.from(token);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const ownExecution = (operation: CancellableOperation<A2ARunResult>): OwnedExecution<A2ARunResult> => {
    const execution = asCancellableExecution(operation);
    let cancelled = false;
    let owned!: OwnedExecution<A2ARunResult>;
    owned = {
      completion: execution.completion.finally(() => { executions.delete(owned); }),
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        execution.cancel();
      },
    };
    executions.add(owned);
    return owned;
  };
  const canWrite = (res: ServerResponse): boolean =>
    !res.destroyed && !res.writableEnded;
  const sendJson = (res: ServerResponse, status: number, value: unknown): boolean => {
    if (!canWrite(res)) return false;
    res.writeHead(status);
    res.end(JSON.stringify(value));
    return true;
  };
  const pushState = (task: A2ATask): void => {
    if (!task.pushUrl) return;
    void fetch(task.pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, state: task.state, error: task.error }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => { /* fire-and-forget：push 失败不阻断任务 */ });
  };
  const server: Server = createServer((req, res) => {
    if (!accepting) {
      res.setHeader('Connection', 'close');
      res.setHeader('Content-Type', 'application/json');
      sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'server stopping' } });
      return;
    }
    if (req.method === 'GET' && (req.url === '/.well-known/agent.json' || req.url === '/.well-known/agent-card.json')) {
      const card = buildAgentCard({
        name: opts.card?.name ?? 'wxnodus',
        description: opts.card?.description ?? 'Windows 本地 AI 编码 CLI（数据不出机）',
        url: serverUrl,
        skills: opts.card?.skills ?? [],
        pushNotifications: true,
      });
      res.setHeader('Content-Type', 'application/json');
      sendJson(res, 200, card);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') {
      sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32601, message: 'method not found' } });
      return;
    }
    // V4 P0-7 认证门（先于 body 读取）：Bearer 必须 + Content-Type 必须 application/json。
    // application/json 使浏览器跨站请求必经 CORS 预检（预检不带凭据→401）——simple request
    // （text/plain）无预检即可跨站发送的路径被彻底封死。agent.json 卡片保留公开（发现性，零敏感）。
    if (String(req.headers['content-type'] ?? '').toLowerCase().indexOf('application/json') < 0) {
      sendJson(res, 415, { jsonrpc: '2.0', error: { code: -32001, message: 'content-type must be application/json' } });
      return;
    }
    if (!bearerOk(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32002, message: 'missing or invalid bearer token' } });
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      void (async () => {
        try {
          const msg = JSON.parse(body || '{}');
          const id = msg.id ?? null;
          if (msg?.method === 'messages/send') {
            if (!accepting || !canWrite(res)) return;
            const text = msg?.params?.message?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
            const execution = ownExecution(run(String(text), {
              sessionId: nextSessionId('message'),
            }));
            const cancelOnDisconnect = (): void => {
              if (!res.writableEnded) execution.cancel();
            };
            req.once('aborted', cancelOnDisconnect);
            res.once('close', cancelOnDisconnect);
            try {
              const r = await execution.completion;
              if (!r.ok) {
                sendJson(res, 200, {
                  jsonrpc: '2.0',
                  id,
                  error: {
                    code: r.status === 'cancelled' ? -32800 : -32603,
                    message: r.error || r.text || `run ${r.status ?? 'failed'}`,
                  },
                });
                return;
              }
              sendJson(res, 200, {
                jsonrpc: '2.0', id,
                result: {
                  message: {
                    role: 'agent',
                    parts: [{ text: r.text || '（空回复）' }],
                    messageId: `m-${Date.now().toString(36)}`,
                  },
                },
              });
            } finally {
              req.off('aborted', cancelOnDisconnect);
              res.off('close', cancelOnDisconnect);
            }
          } else if (msg?.method === 'initialize') {
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '0.3.0', capabilities: { tasks: { streaming: false }, pushNotifications: true } } });
          } else if (msg?.method === 'tasks/send') {
            if (!accepting || !canWrite(res)) return;
            const text = msg?.params?.message?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
            const task: A2ATask = { id: nextTaskId(), state: 'submitted', pushUrl: msg?.params?.pushNotificationConfig?.url };
            tasks.set(task.id, task);
            if (!sendJson(res, 200, { jsonrpc: '2.0', id, result: { id: task.id, state: task.state } })) return;
            task.state = 'working';
            pushState(task);
            const execution = ownExecution(run(String(text), {
              sessionId: nextSessionId('task'),
            }));
            task.execution = execution;
            void (async () => {
              try {
                const result = await execution.completion;
                if (task.state === 'canceled') return;
                if (!result.ok) {
                  task.state = failedTaskState(result);
                  task.error = result.error || result.text || `run ${result.status ?? 'failed'}`;
                  pushState(task);
                  return;
                }
                task.artifact = artifactOf(result);
                task.state = 'completed';
                pushState(task);
              } catch (e: any) {
                if (task.state !== 'canceled') { task.state = 'failed'; task.error = String(e?.message ?? e).slice(0, 200); pushState(task); }
              } finally {
                if (task.execution === execution) task.execution = undefined;
              }
            })();
          } else if (msg?.method === 'tasks/get') {
            const task = tasks.get(String(msg?.params?.id ?? ''));
            if (!task) { sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'task not found' } }); return; }
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { id: task.id, state: task.state, artifact: task.artifact, error: task.error } });
          } else if (msg?.method === 'tasks/cancel') {
            const task = tasks.get(String(msg?.params?.id ?? ''));
            if (!task) { sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'task not found' } }); return; }
            if (task.state === 'submitted' || task.state === 'working') {
              task.state = 'canceled';
              task.execution?.cancel();
              pushState(task);
            }
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { id: task.id, state: task.state } });
          } else {
            sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
          }
        } catch (e: any) {
          sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: String(e?.message ?? e) } });
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = (server.address() as { port: number }).port;
  serverUrl = `http://127.0.0.1:${actual}/`;
  return {
    url: serverUrl,
    token,
    stop: () => {
      if (stopping) return stopping;
      accepting = false;
      const closed = new Promise<void>((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
      stopping = (async () => {
        for (const task of tasks.values()) {
          if (task.state === 'submitted' || task.state === 'working') {
            task.state = 'canceled';
          }
        }
        const active = [...executions];
        for (const execution of active) execution.cancel();
        await Promise.allSettled(active.map(execution => execution.completion));
        server.closeAllConnections();
        await closed;
      })();
      return stopping;
    },
  };
}

/** stdio 行协议传输（NDJSON 一行一帧；initialize/messages/send/tasks/* 与 HTTP 端同语义）。
 * 供宿主进程管道接入——响应按序写 stdout，绝不混行。 */
export function a2aStdioServe(opts: { run: A2ARunner }): void {
  const tasks = new Map<string, A2ATask>();
  const write = (obj: unknown): void => { process.stdout.write(`${JSON.stringify(obj)}\n`); };
  let buffer = '';
  let chain: Promise<void> = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
        const id = msg.id ?? null;
        try {
          if (msg?.method === 'initialize') {
            write({ jsonrpc: '2.0', id, result: { protocolVersion: '0.3.0', capabilities: { tasks: { streaming: false }, pushNotifications: false } } });
          } else if (msg?.method === 'messages/send') {
            const text = msg?.params?.message?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
            const execution = asCancellableExecution(opts.run(String(text), {
              sessionId: nextSessionId('message'),
            }));
            const r = await execution.completion;
            if (!r.ok) {
              write({
                jsonrpc: '2.0',
                id,
                error: {
                  code: r.status === 'cancelled' ? -32800 : -32603,
                  message: r.error || r.text || `run ${r.status ?? 'failed'}`,
                },
              });
              return;
            }
            write({ jsonrpc: '2.0', id, result: { message: { role: 'agent', parts: [{ text: r.text || '（空回复）' }], messageId: `m-${Date.now().toString(36)}` } } });
          } else if (msg?.method === 'tasks/send') {
            const text = msg?.params?.message?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
            const task: A2ATask = { id: nextTaskId(), state: 'submitted' };
            tasks.set(task.id, task);
            write({ jsonrpc: '2.0', id, result: { id: task.id, state: task.state } });
            task.state = 'working';
            task.execution = asCancellableExecution(opts.run(String(text), {
              sessionId: nextSessionId('task'),
            }));
            void (async () => {
              try {
                const result = await task.execution!.completion;
                if (task.state === 'canceled') return;
                if (!result.ok) {
                  task.state = failedTaskState(result);
                  task.error = result.error || result.text || `run ${result.status ?? 'failed'}`;
                  return;
                }
                task.artifact = artifactOf(result);
                task.state = 'completed';
              } catch (e: any) {
                if (task.state !== 'canceled') { task.state = 'failed'; task.error = String(e?.message ?? e).slice(0, 200); }
              } finally {
                task.execution = undefined;
              }
            })();
          } else if (msg?.method === 'tasks/get') {
            const task = tasks.get(String(msg?.params?.id ?? ''));
            if (!task) { write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'task not found' } }); return; }
            write({ jsonrpc: '2.0', id, result: { id: task.id, state: task.state, artifact: task.artifact, error: task.error } });
          } else if (msg?.method === 'tasks/cancel') {
            const task = tasks.get(String(msg?.params?.id ?? ''));
            if (!task) { write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'task not found' } }); return; }
            if (task.state === 'submitted' || task.state === 'working') {
              task.state = 'canceled';
              task.execution?.cancel();
            }
            write({ jsonrpc: '2.0', id, result: { id: task.id, state: task.state } });
          } else {
            write({ jsonrpc: '2.0', id, result: {} });
          }
        } catch (e: any) {
          write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
        }
      });
    }
  });
}
