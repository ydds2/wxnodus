// src/kernel/a2a.ts — Agent-to-Agent 协议（HTTP JSON-RPC，A2A 规范 messages/send 子集）
// 设计：本地化为准——/a2a call 调用对端 agent（任何实现 A2A 的端点），
//       /a2a serve 启动本机 A2A 端点（localhost 监听，agent.run 应答）
import { createServer, type Server } from 'node:http';

export interface A2AResponse {
  ok: boolean;
  text: string;
  messageId?: string;
  error?: string;
}

// 客户端：POST messages/send → 提取对端文本回复
export async function a2aCall(url: string, text: string, opts: { timeoutMs?: number } = {}): Promise<A2AResponse> {
  const timeout = opts.timeoutMs ?? 120_000;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

export interface A2AServer {
  url: string;
  stop(): void;
}

// 服务端：POST / 处理 messages/send（jsonrpc），agent.run 应答
export async function a2aServe(port: number, run: (text: string) => Promise<{ ok: boolean; text: string }>): Promise<A2AServer> {
  const server: Server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') {
      res.writeHead(404); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'method not found' } })); return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      void (async () => {
        try {
          const msg = JSON.parse(body || '{}');
          if (msg?.method === 'messages/send') {
            const text = msg?.params?.message?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
            const r = await run(String(text));
            const out = {
              jsonrpc: '2.0',
              id: msg.id ?? null,
              result: {
                message: {
                  role: 'agent',
                  parts: [{ text: r.text || (r.ok ? '（空回复）' : '模型未配置——/key set <密钥> 配置后使用') }],
                  messageId: `m-${Date.now().toString(36)}`,
                },
              },
            };
            res.writeHead(200); res.end(JSON.stringify(out));
          } else if (msg?.method === 'initialize') {
            res.writeHead(200); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '1.0', capabilities: { tasks: { streaming: false } } } }));
          } else {
            res.writeHead(200); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: {} }));
          }
        } catch (e: any) {
          res.writeHead(500); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e?.message ?? e) } }));
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    stop: () => { try { server.close(); } catch { /* 忽略 */ } },
  };
}
