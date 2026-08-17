// src/kernel/acp.ts — Agent Client Protocol（ACP）stdio JSON-RPC 服务器
// 设计：IDE 集成协议（Zed/JetBrains 等 ACP 客户端）——stdin 读行 JSON-RPC，
//       initialize → session/new → prompt（agent.run 执行）→ assistant 消息响应
//       本地化为准：不依赖外部服务，当前 agent 实例应答
import { createInterface } from 'node:readline';
import { WXNODUS_VERSION } from './version.js';

export interface AcpOptions {
  run: (text: string, sessionId?: string) => Promise<{ ok: boolean; text: string }>;
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

    rl.on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      const { id, method, params } = msg ?? {};

      switch (method) {
        case 'initialize':
          respond(id, {
            protocolVersion: 1,
            capabilities: { config: true, prompt: true, resolution: { supportsEdit: false } },
            clientInfo: { name: 'wxnodus', version: WXNODUS_VERSION },
          });
          break;
        case 'session/new':
          respond(id, { session: { id: `acp-${Date.now().toString(36)}` } });
          break;
        case 'session/load':
          respond(id, { session: { id: String(params?.sessionId ?? '') } });
          break;
        case 'session/load_history': {
          const sid = String(params?.sessionId ?? '');
          const s = sessions.get(sid);
          respond(id, { history: s?.history ?? [] });
          break;
        }
        case 'prompt': {
          const sid = String(params?.sessionId ?? '');
          const content = String(params?.content ?? '');
          const s = sessions.get(sid) ?? { id: sid, history: [] };
          s.history.push({ role: 'user', content });
          sessions.set(sid, s);
          void opts.run(content, sid).then((r) => {
            s.history.push({ role: 'assistant', content: r.text || (r.ok ? '' : '模型未配置——/key set <密钥> 配置后使用') });
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
