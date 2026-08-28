// packages/sdk/src/index.ts — @wxnodus/sdk（A-S2 · 2026-08-28）
// 形态参考 opencode sdk/js 的 spawn-attach 本地服务模型（实现原创）：
//   launchWxnodus() → spawn `wxnodus --serve --sdk` → stdout 首个握手 JSON 行（随机端口+随机 token，
//   管道私有即安全边界，绝不落盘/入 env）→ typed client（POST /rpc + GET /events SSE）→ stop() 托管退出。
// 零云端：网关仅绑 127.0.0.1；凭据生命周期 = 子进程生命周期。
// 已知边界（如实）：serve RPC 白名单当前为 chat/command/memory.search/memory.recall/sessions；
// 审批应答（*.respond）尚在 wire/in-process 通道，serve 面待扩展（roadmap G-6）——SDK 先提供通用 rpc。
import { spawn, type ChildProcess } from 'node:child_process';

export interface SdkHandshake {
  'wxnodus-sdk': 1;
  port: number;
  token: string;
  pid: number;
  version: string;
  protocolVersion: number;
}

export interface LaunchOptions {
  /** wxnodus 可执行入口：PATH 中的命令名（默认 'wxnodus'）或 .js 入口文件（经 process.execPath 运行） */
  bin?: string;
  /** 透传给子进程的额外 CLI 参数（如 --cwd） */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 握手等待上限（默认 20s） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GatewayEvent {
  id?: string;
  type?: string;
  payload?: unknown;
  [key: string]: unknown;
}

export interface WxnodusHandle {
  handshake: SdkHandshake;
  baseUrl: string;
  /** POST /rpc —— 返回网关 JSON 响应体原样（各方法回包形状见网关文档） */
  rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  /** GET /events SSE 订阅——handler 收到逐事件对象；返回取消函数 */
  events(handler: (e: GatewayEvent) => void): Promise<() => void>;
  /** 终止子进程（SIGTERM；2s 后 SIGKILL 兜底）并等待退出 */
  stop(): Promise<void>;
}

const isHandshake = (obj: unknown): obj is SdkHandshake => {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return o['wxnodus-sdk'] === 1 && typeof o.port === 'number' && typeof o.token === 'string' && typeof o.pid === 'number';
};

/**
 * 拉起 wxnodus SDK 网关并完成握手。
 * 失败诚实回显：子进程先退/超时 → 抛错附 stderr 尾部 200 字（启动诊断直达）。
 */
export async function launchWxnodus(opts: LaunchOptions = {}): Promise<WxnodusHandle> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const bin = opts.bin ?? 'wxnodus';
  const isJs = /\.(js|mjs|cjs)$/i.test(bin);
  const cmd = isJs ? process.execPath : bin;
  const pre = isJs ? [bin] : [];
  const child: ChildProcess = spawn(cmd, [...pre, '--serve', '--sdk', ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuf = '';
  let stderrTail = '';
  let settled = false;
  let dataHandler: ((chunk: Buffer) => void) | null = null; // 握手期 stdout 监听（cleanup 摘除）
  const cleanup = () => { if (dataHandler) { try { child.stdout?.removeListener('data', dataHandler); } catch { /* 已关闭 */ } } };

  const handshake = await new Promise<SdkHandshake>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return; settled = true; cleanup();
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new Error(`wxnodus SDK 握手超时（${timeoutMs}ms）——stdout 头部：${stdoutBuf.slice(0, 200)}；stderr：${stderrTail.slice(-200)}`));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new Error(`wxnodus SDK 子进程握手前退出（code=${code}）——stderr：${stderrTail.slice(-200)}`));
    };
    function onData(chunk: Buffer) {
      stdoutBuf += String(chunk);
      const nl = stdoutBuf.indexOf('\n');
      if (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (isHandshake(parsed)) {
              if (settled) return; settled = true; clearTimeout(timer);
              child.removeListener('exit', onExit);
              cleanup();
              resolve(parsed);
              return;
            }
          } catch { /* 非握手行继续等 */ }
        }
        onData(Buffer.from('')); // 继续检查缓冲中的后续行
      }
    }
    dataHandler = onData;
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => { stderrTail = (stderrTail + String(c)).slice(-2000); });
    child.once('exit', onExit);
    opts.signal?.addEventListener('abort', () => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new Error('已中止（signal）'));
    }, { once: true });
  });

  const baseUrl = `http://127.0.0.1:${handshake.port}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${handshake.token}`,
  };

  return {
    handshake,
    baseUrl,
    async rpc(method, params = {}) {
      const resp = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, params }),
      });
      const text = await resp.text();
      try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 300) }; }
    },
    async events(handler) {
      const controller = new AbortController();
      const resp = await fetch(`${baseUrl}/events`, { headers: { Authorization: headers.Authorization, Accept: 'text/event-stream' }, signal: controller.signal });
      if (!resp.ok || !resp.body) throw new Error(`SSE 订阅失败 HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              try { handler(JSON.parse(data)); } catch { /* 坏帧跳过 */ }
            }
          }
        } catch { /* 流取消/断开 */ }
      })();
      return () => controller.abort();
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill();
      const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2_000);
      await exited;
      clearTimeout(force);
    },
  };
}

export { PROTOCOL_VERSION_CLIENT } from './protocol.js';
