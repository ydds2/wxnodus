// src/kernel/acp.ts — Agent Client Protocol（ACP）stdio JSON-RPC 服务器
// 设计：IDE 集成协议（Zed/JetBrains 等 ACP 客户端）——stdin 读行 JSON-RPC，
//       initialize → session/new → prompt（agent.run 执行）→ assistant 消息响应
//       本地化为准：不依赖外部服务，当前 agent 实例应答
// P3 评估轮：session/load 全量（gemini acpResume / kimi server.py load_session:101 /
//       opencode service.ts:211 对标）——store 注入后 session/new 落库真会话行、
//       session/load 校验存在性 + load_history 真历史；无 store 降级内存会话（诚实标注）。
//       诚实边界：prompt 执行仍走宿主 agent 的会话绑定（agent 实例创建即绑会话，
//       run 无 sid 参数）——sid 透传保留未来多会话接线；session/cancel 暂不支持（诚实报错）。
import { createInterface } from 'node:readline';
import { WXNODUS_VERSION } from './version.js';

/** 会话存储注入（命令层由 db 装配；缺省 → 内存会话降级） */
export interface AcpStore {
  createSession: () => string;
  sessionExists: (id: string) => boolean;
  loadHistory: (id: string) => Array<{ role: string; content: string }>;
}

export interface AcpOptions {
  run: (text: string, sessionId?: string) => Promise<{ ok: boolean; text: string }>;
  store?: AcpStore;
}

interface AcpSession {
  id: string;
  history: Array<{ role: string; content: string }>;
}

// 启动 ACP stdio 服务器（阻塞直到 stdin EOF；返回退出码）
export function runAcpServer(opts: AcpOptions): Promise<number> {
  return new Promise((resolve) => {
    const sessions = new Map<string, AcpSession>();
    const rl = createInterface({ input: process.stdin });

    const respond = (id: unknown, result: unknown) => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    };
    const respondError = (id: unknown, code: number, message: string) => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
    };

    const newSessionId = (): string => {
      if (opts.store) return opts.store.createSession();
      return `acp-${Date.now().toString(36)}`;
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
              loadSession: !!opts.store, // store 注入才有真加载（kimi load_session=True 对标）
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
            // ACP 规范：无 sessionId → 新建会话
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
          const s = sessions.get(sid);
          respond(id, { history: s?.history ?? [] });
          break;
        }
        case 'session/update':
          // 客户端通知（model/mode/cwd 变更）——当前宿主 agent 会话绑定不动，诚实 ack
          respond(id, {});
          break;
        case 'session/cancel':
          // 诚实边界：宿主 agent 无 sid 级 abort 通道——不假装取消
          respondError(id, -32601, 'session/cancel 暂不支持（宿主 agent 会话绑定，无 sid 级 abort）');
          break;
        case 'prompt': {
          const sid = String(params?.sessionId ?? '');
          const content = String(params?.content ?? '');
          const s = sessions.get(sid) ?? { id: sid, history: [] };
          s.history.push({ role: 'user', content });
          sessions.set(sid, s);
          void opts.run(content, sid).then((r) => {
            s.history.push({ role: 'assistant', content: r.text || (r.ok ? '' : '模型未配置——/model set-key <密钥> 配置后使用') });
            respond(id, { message: { role: 'assistant', content: s.history[s.history.length - 1]!.content } });
          }).catch((e: any) => respondError(id, -32603, String(e?.message ?? e)));
          break;
        }
        default:
          respondError(id, -32601, `unknown method: ${method}`);
      }
    });

    rl.on('close', () => resolve(0));
  });
}
