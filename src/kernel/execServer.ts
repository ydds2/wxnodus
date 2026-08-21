// src/kernel/execServer.ts — 长驻 exec-server（supremacy S-04 完整版 / roadmap 阶段 2，2026-08-18）
// 机制参考：codex exec-server（远程机长驻服务、滚动 token 鉴权、沙盒内执行工具）——实现原创。
// 安全面对齐口径（诚实）：
//   - 默认 127.0.0.1 仅本机监听（远程部署经 SSH 隧道或显式 --host 0.0.0.0，后者返回 honest 警告）
//   - Bearer token = HMAC-SHA256(secret, 'wxnodus-exec-server') 派生（共享口令派生、timingSafeEqual 比较）
//   - 请求体 64KB 上限；命令经远端 OS 沙盒（winSandbox 同族）可选 profile 执行
//   - 与 ssh 通道（sshRemote.ts）的区别：本通道**远端可沙盒**（profile 参数），输出标注 sandboxed
// 消费方：/remote server|connect|run、bash 工具远程分支（settings.remoteServer 优先于 settings.remote）。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

export interface ExecServerOptions {
  port?: number;              // 0=随机端口
  secret: string;             // 共享口令（token 派生源）
  dataDir: string;            // 沙盒 runner 落盘目录（远端机上）
  host?: string;              // 默认 127.0.0.1；0.0.0.0 时返回 warning 标注
  defaultProfile?: 'off' | 'L0' | 'L1' | 'L2' | 'L3'; // 缺省远端沙盒档（off=普通执行）
  maxBodyBytes?: number;
}

export interface ExecServerHandle {
  port: number;
  host: string;
  warning: string | null;
  close(): Promise<void>;
}

export const EXEC_BODY_LIMIT = 64 * 1024;

/** Bearer token 派生（HMAC-SHA256——与共享口令单向绑定，口令不落盘不传输） */
export function deriveExecToken(secret: string): string {
  return createHmac('sha256', String(secret ?? '')).update('wxnodus-exec-server').digest('hex');
}

/** 远端命令执行结果（客户端消费同型——/exec 响应体） */
export interface RemoteExecResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
  sandboxed: boolean;
  note: string | null;
  error: string | null;
}

function safeCompare(provided: Buffer, expected: string): boolean {
  const e = Buffer.from(expected);
  return provided.length === e.length && timingSafeEqual(provided, e);
}

/** 启动 exec-server（返回实际端口——port=0 时由系统分配） */
export function startExecServer(opts: ExecServerOptions): Promise<ExecServerHandle> {
  return new Promise((resolve, reject) => {
    const host = opts.host ?? '127.0.0.1';
    const warning = host !== '127.0.0.1' && host !== 'localhost' ? '监听非回环地址（' + host + '）——远端网络可达：务必经 SSH 隧道或可信内网使用，token 泄露=远端用户权限' : null;
    const token = deriveExecToken(opts.secret);
    const maxBody = opts.maxBodyBytes ?? EXEC_BODY_LIMIT;
    const defaultProfile = opts.defaultProfile ?? 'off';

    const runOne = async (command: string, cwd: string, profile: string, timeoutMs: number): Promise<RemoteExecResult> => {
      const wantSandbox = profile !== 'off' && (['L0', 'L1', 'L2', 'L3'] as const).includes(profile as never);
      if (wantSandbox) {
        // 远端 OS 沙盒复用（winSandbox 同族逻辑在远端机上跑）
        const { trySandboxLaunch } = await import('./winSandbox.js');
        const r = await trySandboxLaunch({
          settings: { sandbox: { profile } },
          dataDir: opts.dataDir,
          cmd: 'powershell.exe',
          args: ['-NoProfile', '-Command', command],
          cwd,
          timeoutMs,
        });
        if (r.result) {
          const { readFileSync, rmSync } = await import('node:fs');
          let out = ''; let err = '';
          try { out = readFileSync(r.result.outPath, 'utf8').slice(0, 60_000); } catch { /* 忽略 */ }
          try { err = readFileSync(r.result.errPath, 'utf8').slice(0, 8_000); } catch { /* 忽略 */ }
          // V4 P5-4（C 级）：沙盒输出临时文件读后即清——此前长驻服务每次 /exec 落两个
          // 文件永不删（磁盘无界累积；输出含命令产物也属敏感残留）
          try { rmSync(r.result.outPath, { force: true }); rmSync(r.result.errPath, { force: true }); } catch { /* 清理失败不阻断响应 */ }
          return { ok: r.result.code === 0, code: r.result.code, out, err, sandboxed: true, note: `远端 OS 沙盒 ${profile}`, error: null };
        }
        return { ok: false, code: null, out: '', err: '', sandboxed: false, note: null, error: `远端沙盒不可用（${r.reason ?? '?'}${r.note ? '——' + r.note : ''}）——已拒绝执行（不降级裸跑：诚实 fail-closed）` };
      }
      // 普通执行（profile=off——等同 ssh 通道语义，未沙盒诚实标注）
      return await new Promise<RemoteExecResult>((res) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        }, (e, stdout, stderr) => {
          const code = e && typeof (e as any).code === 'number' ? (e as any).code : e ? 1 : 0;
          const killed = e && (e as any).killed;
          res({
            ok: !e, code: e ? (killed ? null : code) : 0,
            out: String(stdout ?? '').slice(0, 60_000),
            err: String(stderr ?? '').slice(0, 8_000),
            sandboxed: false,
            note: '远端未沙盒（profile=off——命令以远端用户权限执行）',
            error: e ? `远端命令失败：${String((e as any)?.message ?? e).slice(0, 200)}` : null,
          });
        });
      });
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && url.pathname === '/health/live') {
        json(200, { ok: true, service: 'wxnodus-exec-server' });
        return;
      }
      const bearer = req.headers.authorization ?? '';
      if (!bearer.startsWith('Bearer ') || !safeCompare(Buffer.from(bearer.slice(7)), token)) {
        json(401, { ok: false, error: { code: 'EXEC_TOKEN_INVALID' } });
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/exec') {
        json(404, { ok: false, error: '路由不存在（GET /health/live、POST /exec）' });
        return;
      }
      let body = '';
      let overflow = false;
      req.on('data', (c) => {
        if (overflow) return;
        body += c;
        if (Buffer.byteLength(body) > maxBody) overflow = true;
      });
      req.on('end', () => {
        if (overflow) { json(413, { ok: false, error: { code: 'EXEC_BODY_TOO_LARGE' } }); return; }
        let parsed: { command?: string; cwd?: string; timeoutMs?: number; profile?: string };
        try { parsed = JSON.parse(body || '{}'); } catch { json(400, { ok: false, error: 'body 非 JSON' }); return; }
        const command = String(parsed.command ?? '').trim();
        if (!command) { json(400, { ok: false, error: 'command 必填' }); return; }
        const cwd = String(parsed.cwd ?? process.cwd());
        const timeoutMs = Math.min(Math.max(Number(parsed.timeoutMs) || 60_000, 1_000), 300_000);
        const profile = ['L0', 'L1', 'L2', 'L3', 'off'].includes(String(parsed.profile ?? '')) ? String(parsed.profile) : defaultProfile;
        void runOne(command, cwd, profile, timeoutMs).then(r => json(200, r)).catch((e: any) => json(500, { ok: false, error: String(e?.message ?? e).slice(0, 300) }));
      });
    });

    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, host, warning, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** 客户端：经 exec-server 执行远端命令（fetch + Bearer token；超时/网络/401 诚实报错） */
export async function runRemoteExecServer(
  target: { host: string; port: number; token: string },
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<RemoteExecResult & { transportError: string | null }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  try {
    const resp = await fetch(`http://${target.host}:${target.port}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
      body: JSON.stringify({ command, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    if (resp.status === 401) return { ok: false, code: null, out: '', err: '', sandboxed: false, note: null, error: 'exec-server 令牌无效（/remote connect --secret 与 server 端共享口令不一致）', transportError: '401' };
    const j = (await resp.json().catch(() => null)) as RemoteExecResult | null;
    if (!j) return { ok: false, code: null, out: '', err: '', sandboxed: false, note: null, error: `exec-server 响应异常（HTTP ${resp.status}）`, transportError: String(resp.status) };
    return { ...j, transportError: null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const hint = /ENOTFOUND|ECONNREFUSED/i.test(msg) ? '——远端服务不可达（/remote connect 检查 host:port；远端机先 /remote server 启动）' : '';
    return { ok: false, code: null, out: '', err: '', sandboxed: false, note: null, error: `exec-server 连接失败：${msg.slice(0, 200)}${hint}`, transportError: 'network' };
  }
}

/** 客户端 token 派生（与 server 同源——shared secret 双向派生，secret 不落盘不传输） */
export const deriveExecTokenClient = deriveExecToken;
