// src/presentation/http/panelServer.ts — /panel 轻量配置面板服务（2026-09-04 · 用户需求：HTML 动态配置）
// 定位：TUI 单用户本机面板（与 --serve 多用户网关不同面——无会话所有权模型，刻意轻量）：
//   GET  /panel        → 单文件 HTML（panelPage——命令目录注入，无敏感数据，本机回环可达）
//   POST /api/rpc      → { method:'command', command } → CommandBus（权限/硬红线/审计全生效）
// 安全四层：① 仅绑定 127.0.0.1（外网不可达）；② 随机 32 字节 token（timingSafeEqual 校验，
//   不落盘不进环境变量——TUI 内存持有，随进程消亡）；③ 命令头白名单（resolveAlias 后必须
//   ∈ SLASH 注册表——任意字符串/路径探测一律 404/400）；④ 响应 no-store + CSP 严格内联。
// 生命周期：TUI /panel 懒起单例（复用已起实例）；resetPanelServerForTests 为 K3 教育 seam。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveAlias } from '../../kernel/commandLevels.js';
import { renderPanelPage, type PanelCatalog } from './panelPage.js';

export interface PanelServerDeps {
  commandBus: { execute(cmd: string, context?: { signal?: AbortSignal }): Promise<{ ok: boolean; output?: string; error?: string; completionStatus?: string }> };
  catalog: PanelCatalog;
  version?: string;
}

export interface PanelServerHandle {
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

const COMMON_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function send(res: ServerResponse, status: number, body: string, type: 'text/html; charset=utf-8' | 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, ...COMMON_HEADERS, ...extra });
  res.end(body);
}

function tokenOk(provided: string, expect: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 起面板服务（127.0.0.1 随机端口）。命令白名单 ∈ SLASH（经 alias 解析——与 TUI 同一命令面）。 */
export function startPanelServer(deps: PanelServerDeps): Promise<PanelServerHandle> {
  const token = randomBytes(32).toString('hex');
  const html = renderPanelPage({ catalog: deps.catalog, version: deps.version });
  const allowed = new Set(deps.catalog.slash.map(s => s.toLowerCase()));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/panel' || url.pathname === '/')) {
      send(res, 200, html, 'text/html; charset=utf-8', {
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      // Bearer token 校验（恒时比较）
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith('Bearer ') || !tokenOk(auth.slice(7).trim(), token)) {
        send(res, 401, JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }), 'application/json; charset=utf-8');
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        void (async () => {
          let parsed: { method?: string; command?: string };
          try { parsed = JSON.parse(body || '{}'); } catch { send(res, 400, JSON.stringify({ ok: false, error: { code: 'BAD_JSON' } }), 'application/json; charset=utf-8'); return; }
          if (parsed.method !== 'command' || typeof parsed.command !== 'string' || !parsed.command.trim()) {
            send(res, 400, JSON.stringify({ ok: false, error: { code: 'COMMAND_REQUIRED' } }), 'application/json; charset=utf-8');
            return;
          }
          // 白名单：命令头（alias 解析后）必须 ∈ SLASH——路径探测/任意串一律拒绝
          const head = resolveAlias(parsed.command.trim().split(/\s+/)[0] ?? '').toLowerCase();
          if (!allowed.has(head)) {
            send(res, 404, JSON.stringify({ ok: false, error: { code: 'UNKNOWN_COMMAND', message: `未注册命令：${head}` } }), 'application/json; charset=utf-8');
            return;
          }
          try {
            const r = await deps.commandBus.execute(parsed.command.trim());
            send(res, 200, JSON.stringify({ ok: r.ok, output: r.output ?? null, error: r.error ?? null }), 'application/json; charset=utf-8');
          } catch (e: unknown) {
            send(res, 500, JSON.stringify({ ok: false, error: { code: 'EXEC_FAILED', message: String(e instanceof Error ? e.message : e).slice(0, 300) } }), 'application/json; charset=utf-8');
          }
        })();
      });
      return;
    }
    send(res, 404, JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }), 'application/json; charset=utf-8');
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        token,
        url: `http://127.0.0.1:${port}/panel?t=${token}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

// ── TUI /panel 懒单例（K3 教育 seam：测试可复位）──
let panelSingleton: PanelServerHandle | null = null;

export function resetPanelServerForTests(): void {
  if (panelSingleton) { void panelSingleton.close(); panelSingleton = null; }
}

/** 复用或新起面板服务（幂等——再次 /panel 返回同一实例 URL） */
export function ensurePanelServer(deps: PanelServerDeps): Promise<PanelServerHandle> {
  if (panelSingleton) return Promise.resolve(panelSingleton);
  return startPanelServer(deps).then(h => { panelSingleton = h; return h; });
}
