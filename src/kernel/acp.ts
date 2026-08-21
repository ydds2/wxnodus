// src/kernel/acp.ts — Agent Client Protocol（ACP）stdio JSON-RPC 服务器
// transport 本身不占用 Agent Run；每个 prompt 独立接纳并按 session 精确取消。
import { createInterface } from 'node:readline';
import {
  asCancellableExecution,
  type CancellableExecution,
  type CancellableOperation,
} from '../protocol/cancellableExecution.js';
import type { RunFinalStatus } from '../protocol/runs.js';
import { WXNODUS_VERSION } from './version.js';

/** 会话存储注入（命令层由 db 装配；缺省 → 内存会话降级） */
export interface AcpStore {
  createSession: () => string;
  sessionExists: (id: string) => boolean;
  loadHistory: (id: string) => Array<{ role: string; content: string }>;
}

export interface AcpRunResult {
  ok: boolean;
  text: string;
  status?: RunFinalStatus;
  error?: string;
}

export interface AcpOptions {
  run: (
    text: string,
    sessionId: string,
  ) => CancellableOperation<AcpRunResult>;
  store?: AcpStore;
}

interface AcpSession {
  id: string;
  history: Array<{ role: string; content: string }>;
}

// 启动 ACP stdio 服务器（阻塞直到 stdin EOF；stdout 只写 JSON-RPC 帧）。
export function runAcpServer(opts: AcpOptions): Promise<number> {
  return new Promise((resolve) => {
    const sessions = new Map<string, AcpSession>();
    const active = new Map<string, Set<CancellableExecution<AcpRunResult>>>();
    const cancelled = new WeakSet<CancellableExecution<AcpRunResult>>();
    const rl = createInterface({ input: process.stdin });

    const respond = (id: unknown, result: unknown) => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    };
    const respondError = (id: unknown, code: number, message: string) => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
    };
    const newSessionId = (): string => {
      if (opts.store) return opts.store.createSession();
      return `acp-${Date.now().toString(36)}`;
    };
    const track = (
      sessionId: string,
      execution: CancellableExecution<AcpRunResult>,
    ): (() => void) => {
      const executions = active.get(sessionId) ?? new Set();
      executions.add(execution);
      active.set(sessionId, executions);
      return () => {
        executions.delete(execution);
        if (executions.size === 0) active.delete(sessionId);
      };
    };
    const cancelSession = (sessionId: string): number => {
      const executions = [...(active.get(sessionId) ?? [])];
      let count = 0;
      for (const execution of executions) {
        if (cancelled.has(execution)) continue;
        cancelled.add(execution);
        count++;
        execution.cancel();
      }
      return count;
    };

    rl.on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      const { id, method, params } = msg ?? {};

      switch (method) {
        case 'initialize':
          respond(id, {
            protocolVersion: 1,
            capabilities: {
              config: true,
              prompt: true,
              loadSession: !!opts.store,
              cancelSession: true,
              resolution: { supportsEdit: false },
            },
            clientInfo: { name: 'wxnodus', version: WXNODUS_VERSION },
          });
          break;
        case 'session/new':
          respond(id, { session: { id: newSessionId() } });
          break;
        case 'session/load': {
          const sid = String(params?.sessionId ?? '');
          if (!sid) {
            respond(id, { session: { id: newSessionId() } });
            break;
          }
          if (opts.store && !opts.store.sessionExists(sid)) {
            respondError(id, -32602, `session not found: ${sid}`);
            break;
          }
          respond(id, { session: { id: sid } });
          break;
        }
        case 'session/load_history': {
          const sid = String(params?.sessionId ?? '');
          if (opts.store) {
            respond(id, { history: opts.store.loadHistory(sid) });
            break;
          }
          respond(id, { history: sessions.get(sid)?.history ?? [] });
          break;
        }
        case 'session/update':
          respond(id, {});
          break;
        case 'session/cancel': {
          const sid = String(params?.sessionId ?? '');
          if (!sid) {
            respondError(id, -32602, 'sessionId is required');
            break;
          }
          respond(id, { cancelled: cancelSession(sid) });
          break;
        }
        case 'prompt': {
          const sid = String(params?.sessionId ?? '');
          const content = String(params?.content ?? '');
          if (!sid) {
            respondError(id, -32602, 'sessionId is required');
            break;
          }
          const session = sessions.get(sid) ?? { id: sid, history: [] };
          session.history.push({ role: 'user', content });
          // M-1 附带（审计「acp sessions Map 只增不减」）：LRU 界——ACP 协议无
          // session/end，长驻服务会话累积无界；touch 保活跃序，超限淘汰最旧未用
          //（历史仅内存回显用——淘汰不丢持久数据，session/load_history 走 store）
          sessions.delete(sid);
          sessions.set(sid, session);
          while (sessions.size > 64) {
            const oldest = sessions.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            sessions.delete(oldest);
          }
          const execution = asCancellableExecution(opts.run(content, sid));
          const untrack = track(sid, execution);
          void execution.completion.then((result) => {
            if (!result.ok) {
              respondError(
                id,
                result.status === 'cancelled' ? -32800 : -32603,
                result.error || result.text || `run ${result.status ?? 'failed'}`,
              );
              return;
            }
            session.history.push({ role: 'assistant', content: result.text });
            respond(id, {
              message: {
                role: 'assistant',
                content: result.text,
              },
            });
          }).catch((error: any) => {
            respondError(id, -32603, String(error?.message ?? error));
          }).finally(untrack);
          break;
        }
        default:
          respondError(id, -32601, `unknown method: ${method}`);
      }
    });

    rl.on('close', () => {
      const executions = [...active.values()].flatMap(items => [...items]);
      for (const sid of [...active.keys()]) cancelSession(sid);
      void Promise.allSettled(executions.map(execution => execution.completion))
        .then(() => resolve(0));
    });
  });
}
