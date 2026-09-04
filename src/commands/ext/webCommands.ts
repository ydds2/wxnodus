// src/commands/ext/webCommands.ts — 巨文件拆分第 4 块（C-6 · 批次ⅩⅩⅥ）：网络/浏览器/网关/协议接入面
// 自 handlersExt.ts 迁入：/search /browser /web /gateway /proxy /webhook（含 webhook 引擎）/
//   /a2a /acp——与 ext/ 既有块同构（registerXxx(bus, ctx) 单入口；输出 lines() 纯文本同构）
import { lines } from '../outputFormat.js';
import type { HandlerCtx } from '../handlers.js';
import type { CommandBus } from '../../app/CommandBus.js';
import { httpStatusForCompletion } from '../../protocol/completionTransport.js';
import { WXNODUS_VERSION } from '../../kernel/version.js';

// ── Webhook 引擎（事件 → HTTP POST 回调；本地化为准，默认全部核心事件）──
const WEBHOOK_EVENTS = ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'system.notice', 'ui.confirm', 'jobs.complete'];
const webhookSubs = new Map<string, () => void>();

function subscribeWebhooks(ctx: HandlerCtx): void {
  const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string; events?: string[] }> | undefined) ?? [];
  for (const h of hooks) {
    if (!h?.url || webhookSubs.has(h.url)) continue;
    const events = h.events?.length ? h.events : WEBHOOK_EVENTS;
    const offs: Array<() => void> = [];
    for (const ev of events) {
      offs.push(ctx.bus.on(ev, (e: any) => {
        // 后台投递，失败静默（不阻断主流程）
        void fetch(h.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: ev, payload: e?.payload ?? null, ts: Date.now() }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => { /* 投递失败忽略 */ });
      }));
    }
    webhookSubs.set(h.url, () => { for (const off of offs) off(); });
  }
}

export function registerWebCommands(bus: CommandBus, ctx: HandlerCtx): void {
  // 启动时订阅既有 webhook 配置（热注册由 /webhook add 处理——随块迁移）
  subscribeWebhooks(ctx);
  // A20：联网搜索（自研 DDG+Bing 双引擎解析，无 API key；SSRF 防护复用）
  // P0-4：--content [N] 搜索即读——对前 N 条结果抓取正文（对标现代 coding 工具的搜索+内容一体）
  bus.register('/search', async (args) => {
    // --engine auto|duckduckgo|bing：指定搜索引擎（默认 auto 双引擎回退）
    const engIdx = args.indexOf('--engine');
    let engine: 'auto' | 'duckduckgo' | 'bing' = 'auto';
    if (engIdx >= 0) {
      const e = String(args[engIdx + 1] ?? 'auto').toLowerCase();
      if (e === 'duckduckgo' || e === 'bing') engine = e;
    }
    // --content [N]：抓取前 N 条结果正文（默认 3；--content 0 关闭）
    const cIdx = args.indexOf('--content');
    let withContent = false;
    let fetchTop = 3;
    if (cIdx >= 0) {
      withContent = true;
      const n = parseInt(String(args[cIdx + 1] ?? ''), 10);
      if (Number.isFinite(n) && n >= 0) fetchTop = n;
    }
    const skip = (i: number) => args[i] === '--engine' || args[i] === '--content' || args[i - 1] === '--engine' || args[i - 1] === '--content';
    const q = args.filter((_, i) => !skip(i)).join(' ').trim();
    if (!q) return '用法：/search <查询词> [--content [N]] [--engine auto|duckduckgo|bing]（双引擎搜索；--content 抓取前 N 条正文）';
    try {
      const { searchWeb, searchWebWithContent } = await import('../../kernel/search.js');
      const proxy = (ctx.config.get('settings') as any)?.proxy as string | undefined;
      const r = withContent
        ? await searchWebWithContent(q, { proxy, engine, fetchTop })
        : await searchWeb(q, { proxy, engine });

      if (!r.ok) {
        return `搜索失败：${r.error}`;
      }

      if (!r.results.length) {
        return '搜索无结果';
      }

      const lines: string[] = [`引擎：${r.engine}`];
      for (const [i, x] of r.results.entries()) {
        lines.push(`${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`);
        const xc = x as { content?: string; contentError?: string };
        if (xc.content) lines.push(`   ── 正文 ──\n   ${xc.content.replace(/\n/g, '\n   ')}`);
        else if (xc.contentError) lines.push(`   ⚠ 正文抓取失败：${xc.contentError}`);
      }
      return lines.join('\n');
    } catch (e: any) {
      return `搜索失败：${e?.message?.slice(0, 300) ?? e}`;
    }
  });

  // P0-1：/browser——浏览器自动化（探测/导航/关闭；AI 工具 browser_* 同链路）
  bus.register('/browser', async (args) => {
    // W3 Browser 第 1 步：组合路由决策——modern/required 在 Playwright 接线完成前 fail-closed
    const { decideBrowserRoute } = await import('../computerRouting.js');
    const browserRoute = decideBrowserRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!browserRoute.ok) {
      throw new Error(`[${browserRoute.error.code}] ${browserRoute.error.message}`);
    }
    // W3 Browser facade：modern 路由经 BrowserSessionService（P0-02 权威：owner 校验/独立 context/URL 逐跳授权）
    // + 入口 UrlPolicy 先验（私网/loopback/DNS fail-closed）+ 证据落盘。
    if (browserRoute.value.route === 'modern') {
      const { BrowserSessionService } = await import('../../application/computer/browserSessionService.js');
      const { createProductionBrowserDriver, authorizeBrowserUrl } = await import('../../application/computer/browserWiring.js');
      const { createComputerEvidenceStore } = await import('../../application/computer/computerEvidenceStore.js');
      const sub = String(args[0] ?? '').toLowerCase();
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      if (sub === 'open') {
        const url = args.slice(1).join(' ').trim();
        if (!url) return '用法：/browser open <URL>（SSRF 防护拦截内网）';
        const authorized = await authorizeBrowserUrl({ url });
        if (!authorized.ok) return `[${authorized.error.code}] ${authorized.error.message}（${String((authorized.error.details as Record<string, unknown> | undefined)?.reason ?? '')}）`;
        const service = new BrowserSessionService(createProductionBrowserDriver());
        const opened = await service.open(sid);
        if (!opened.ok) return `[${opened.error.code}] ${opened.error.message}`;
        const navigated = await opened.value.navigate(authorized.value.url);
        if (!navigated.ok) return `[${navigated.error.code}] ${navigated.error.message}`;
        const evidence = createComputerEvidenceStore(ctx.dataDir);
        const closed = await evidence.closeComputerAction({ kind: 'browser.open', url: authorized.value.url, sessionId: sid });
        return closed.ok ? `已打开 ${authorized.value.url}（证据 ${closed.value.evidenceId}）` : `已打开 ${authorized.value.url}（证据落盘失败：${closed.error.code}）`;
      }
      if (sub === 'close') {
        const service = new BrowserSessionService(createProductionBrowserDriver());
        const closed = await service.close(sid);
        if (!closed.ok) return `[${closed.error.code}] ${closed.error.message}`;
        return '已关闭浏览器会话';
      }
      return 'modern 路由：/browser open <URL> ｜ close（每会话独立 context，URL 逐跳授权 + 证据落盘）';
    }
    const sub = String(args[0] ?? '').toLowerCase();
    const { browserProbe, browserClose, browserNavigate } = await import('../../kernel/browser.js');
    if (sub === 'close') return await browserClose();
    if (sub === 'open') {
      const url = args.slice(1).join(' ').trim();
      if (!url) return '用法：/browser open <URL>（SSRF 防护拦截内网）';
      const r = await browserNavigate(url);
      return r.text.slice(0, 1500);
    }
    // 默认：探测状态
    const probe = browserProbe();
    return probe.ok
      ? `浏览器可用：${probe.browser}\n用法：/browser open <URL> ｜ /browser close（AI 也可经 browser_* 工具自主操作）`
      : `浏览器不可用：${probe.error}\n安装 Microsoft Edge 或 Google Chrome 后重试`;
  });

  // A20：/web 别名（抓取 URL——与 /claw 同链路同防护）
  bus.register('/web', async (args, _raw, execution) => {
    const url = args.join(' ').trim();
    if (!url) return '用法：/web <URL>';
    if (!ctx.commandBus) return '命令总线不可用';

    const r = await ctx.commandBus.execute(`/claw ${url}`, execution);

    return r.output ?? (r.ok ? '' : '抓取失败');
  });

  // /gateway：本地 HTTP JSON-RPC 网关（localhost 监听，POST /rpc 面）
  //   method: prompt {text} → 意图路由执行；command {input} → 命令总线
  let gatewayServer: import('node:http').Server | null = null;
  const gatewayExecutions = new Set<{ cancel(): void }>();
  const cancelGatewayExecutions = (): void => {
    for (const execution of [...gatewayExecutions]) execution.cancel();
  };
  const closeGateway = async (): Promise<void> => {
    cancelGatewayExecutions();
    if (!gatewayServer) return;
    const server = gatewayServer;
    gatewayServer = null;
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  ctx.registerDisposer?.('legacy-gateway', closeGateway);
  bus.register('/gateway', async (args) => {
    const [sub, ...rest] = args;
    const port = parseInt(rest[0] ?? '8765', 10);
    if (sub === 'start' || !sub) {
      if (gatewayServer) return `网关已在运行：http://127.0.0.1:${(gatewayServer.address() as any)?.port ?? port}`;
      const { createServer } = await import('node:http');
      const { randomBytes, timingSafeEqual } = await import('node:crypto');
      // V4 P0-7：Bearer 认证——此前 /rpc 零认证：CORS simple request（text/plain 无需预检）可
      // 从任意浏览器恶意页面跨站驱动 command/prompt（含 /perm yolo 类提权）。OpenCode 同型
      // 缺陷已酿 CVE-2026-22812。token：WXNODUS_GATEWAY_TOKEN 可固定（脚本集成），否则随机。
      const gatewayToken = process.env.WXNODUS_GATEWAY_TOKEN || randomBytes(24).toString('hex');
      const bearerOk = (req: import('node:http').IncomingMessage): boolean => {
        const auth = String(req.headers.authorization ?? '');
        if (!auth.startsWith('Bearer ')) return false;
        const given = Buffer.from(auth.slice(7));
        const want = Buffer.from(gatewayToken);
        return given.length === want.length && timingSafeEqual(given, want);
      };
      gatewayServer = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST' || req.url !== '/rpc') {
          res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        // 认证门先于 body 读取：Content-Type 必须 application/json（封死 simple request 跨站路径）+ Bearer
        if (String(req.headers['content-type'] ?? '').toLowerCase().indexOf('application/json') < 0) {
          res.writeHead(415); res.end(JSON.stringify({ error: 'content-type must be application/json' })); return;
        }
        if (!bearerOk(req)) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'missing or invalid bearer token' })); return;
        }
        // V4 P1-4：Buffer 聚合整体解码（多字节序列跨分包安全——同 serve.ts readBody 修法）
        const bodyChunks: Buffer[] = [];
        let bodyBytes = 0;
        req.on('data', (c: Buffer) => { bodyChunks.push(c); bodyBytes += c.length; if (bodyBytes > 1e6) req.destroy(); });
        req.on('end', () => {
          const body = Buffer.concat(bodyChunks).toString('utf8');
          void (async () => {
            try {
              const { method, params } = JSON.parse(body || '{}');
              const sessionId = String(params?.session_id ?? ctx.agent?.getSessionId?.() ?? 'default');
              if (method === 'command') {
                if (!ctx.runInvocation) { res.writeHead(503); res.end(JSON.stringify({ error: 'run admission unavailable' })); return; }
                const handle = ctx.runInvocation.invoke({
                  kind: 'command',
                  command: String(params?.input ?? ''),
                  sessionId,
                });
                const cancel = () => { if (!res.writableEnded) handle.cancel(); };
                gatewayExecutions.add(handle);
                req.once('aborted', cancel);
                res.once('close', cancel);
                try {
                  const run = await handle.completion;
                  if (res.destroyed || res.writableEnded) return;
                  const r = run.value;
                  res.writeHead(httpStatusForCompletion(run.status)); res.end(JSON.stringify({
                    ok: run.status === 'succeeded',
                    status: run.status,
                    run_id: handle.context.runId,
                    output: r?.output || r?.dispatch?.message || run.error || r?.error || '',
                  }));
                } finally {
                  req.off('aborted', cancel);
                  res.off('close', cancel);
                  gatewayExecutions.delete(handle);
                }
              } else if (method === 'prompt') {
                if (!ctx.runInvocation) { res.writeHead(503); res.end(JSON.stringify({ error: 'run admission unavailable' })); return; }
                const handle = ctx.runInvocation.invoke({
                  kind: 'agent',
                  prompt: String(params?.text ?? ''),
                  sessionId,
                });
                const cancel = () => { if (!res.writableEnded) handle.cancel(); };
                gatewayExecutions.add(handle);
                req.once('aborted', cancel);
                res.once('close', cancel);
                try {
                  const run = await handle.completion;
                  if (res.destroyed || res.writableEnded) return;
                  const r = run.value;
                  res.writeHead(httpStatusForCompletion(run.status)); res.end(JSON.stringify({
                    ok: run.status === 'succeeded',
                    status: run.status,
                    run_id: handle.context.runId,
                    text: r?.text ?? '',
                    turns: r?.turns ?? 0,
                    ...(run.error ? { error: run.error } : {}),
                  }));
                } finally {
                  req.off('aborted', cancel);
                  res.off('close', cancel);
                  gatewayExecutions.delete(handle);
                }
              } else if (method === 'health') {
                res.writeHead(200); res.end(JSON.stringify({ ok: true, version: WXNODUS_VERSION }));
              } else {
                res.writeHead(400); res.end(JSON.stringify({ error: `unknown method: ${method}` }));
              }
            } catch (e: any) {
              if (!res.destroyed && !res.writableEnded) {
                res.writeHead(500); res.end(JSON.stringify({ error: String(e?.message ?? e) }));
              }
            }
          })();
        });
      });
      await new Promise<void>((resolve, reject) => {
        gatewayServer!.once('error', reject);
        gatewayServer!.listen(port, '127.0.0.1', resolve);
      }).catch(() => { gatewayServer = null; return; });
      if (!gatewayServer) return `启动失败：端口 ${port} 可能被占用（/gateway start <其他端口>）`;
      const activePort = (gatewayServer.address() as import('node:net').AddressInfo).port;
      return `__KEEPALIVE__\n网关已启动：http://127.0.0.1:${activePort}（POST /rpc，method=command|prompt|health；仅本机监听，SIGINT 停止）\n访问令牌（Bearer，仅此一次展示；WXNODUS_GATEWAY_TOKEN 可固定）：${gatewayToken}`;
    }
    if (sub === 'stop') {
      if (!gatewayServer) return '网关未运行';
      await closeGateway();
      return '网关已停止';
    }
    if (sub === 'status') {
      return gatewayServer
        ? `运行中：http://127.0.0.1:${(gatewayServer.address() as any)?.port ?? port}`
        : '未运行（/gateway start [端口] 启动本地 JSON-RPC 网关）';
    }
    return '用法：/gateway start [端口]｜stop｜status';
  });

  bus.register('/proxy', (args) => {
    const v = args[0];
    if (v) { ctx.config.setKey('settings', 'proxy', v); return `代理已设置：${v}`; }
    return `代理：${ctx.config.getKey('settings', 'proxy') ?? '未设置（直连）'}`;
  });

  // /webhook：注册/管理事件回调（真实 HTTP POST 投递，本地事件总线驱动）
  bus.register('/webhook', (args) => {
    const [sub, ...rest] = args;
    if (sub === 'list' || !sub) {
      const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string; events?: string[] }> | undefined) ?? [];
      if (!hooks.length) {
        return lines(' Webhook ', [' 未注册回调', '', ' 用法：/webhook add <URL> [事件...]（事件缺省=全部核心事件）', '       /webhook remove <URL>', '       /webhook test <URL>']);
      }
      return lines(' Webhook ', hooks.map(h => ` ${h.url}（${(h.events ?? WEBHOOK_EVENTS).length} 事件）`));
    }
    if (sub === 'add') {
      const url = rest[0];
      if (!/^https?:\/\//.test(url ?? '')) return '用法：/webhook add <URL> [事件...]（http/https 回调）';
      const events = rest.slice(1);
      const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string; events?: string[] }> | undefined) ?? [];
      if (hooks.some(h => h.url === url)) return `已存在回调：${url}`;
      hooks.push({ url, events: events.length ? events : undefined });
      ctx.config.setKey('settings', 'webhooks', hooks);
      subscribeWebhooks(ctx);
      return `已注册回调 ${url}（${events.length ? events.join(',') : '全部核心事件'}）——事件发生时将 POST JSON 到此地址`;
    }
    if (sub === 'remove') {
      const url = rest[0];
      const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string }> | undefined) ?? [];
      const next = hooks.filter(h => h.url !== url);
      if (next.length === hooks.length) return `未找到回调：${url}`;
      ctx.config.setKey('settings', 'webhooks', next);
      webhookSubs.get(url)?.();
      webhookSubs.delete(url);
      return `已移除回调 ${url}`;
    }
    if (sub === 'test') {
      return (async () => {
        const url = rest[0];
        if (!/^https?:\/\//.test(url ?? '')) return '用法：/webhook test <URL>';
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'webhook.test', payload: { message: '测试投递' }, ts: Date.now() }),
            signal: AbortSignal.timeout(8000),
          });
          return `测试投递成功：HTTP ${r.status}`;
        } catch (e: any) {
          return `测试投递失败：${e?.message?.slice(0, 120) ?? e}`;
        }
      })();
    }
    return '用法：/webhook list｜add <URL> [事件...]｜remove <URL>｜test <URL>';
  });

  // /a2a：Agent-to-Agent 协议——call 调用对端 / serve 启动本地端点（A2A messages/send）
  let a2aServer: { url: string; token: string; stop(): Promise<void> } | null = null;
  const closeA2a = async (): Promise<void> => {
    const server = a2aServer;
    a2aServer = null;
    await server?.stop();
  };
  ctx.registerDisposer?.('a2a-server', closeA2a);
  bus.register('/a2a', async (args) => {
    const [sub, ...rest] = args;
    if (sub === 'call') {
      const url = rest[0];
      const text = rest.slice(1).join(' ');
      if (!/^https?:\/\//.test(url ?? '') || !text) return '用法：/a2a call <对端URL> <消息>（A2A messages/send）';
      const { a2aCall } = await import('../../kernel/a2a.js');
      const r = await a2aCall(url, text);
      if (!r.ok) return `A2A 调用失败：${r.error ?? '无响应'}`;
      return lines(' A2A 回复 ', String(r.text).split('\n').slice(0, 20).map(l => ` ${l.slice(0, 110)}`));
    }
    if (sub === 'serve') {
      if (a2aServer) return `A2A 端点运行中：${a2aServer.url}`;
      const port = parseInt(rest[0] ?? '8787', 10);
      if (!ctx.runInvocation) return 'a2a serve 不可用：当前环境未提供 Run 接纳端口';
      const { a2aServe } = await import('../../kernel/a2a.js');
      const { discoverSkills } = await import('../../kernel/skills.js');
      try {
        a2aServer = await a2aServe(port, (text, request) => {
          const handle = ctx.runInvocation!.invoke({
            kind: 'agent',
            prompt: text,
            sessionId: request.sessionId,
          });
          return {
            cancel: () => handle.cancel(),
            completion: handle.completion.then(run => ({
              ok: run.status === 'succeeded',
              status: run.status,
              text: run.value?.text ?? '',
              error: run.error,
            })),
          };
        }, {
          // 完整版：agent card 携带真实技能声明（对端可发现本机能力面）
          card: {
            name: 'wxnodus',
            description: 'Windows 本地 AI 编码 CLI（数据不出机）',
            skills: discoverSkills(ctx.dataDir, ctx.cwd).slice(0, 50).map(s => ({ name: s.name, description: s.description })),
          },
        });
        return `__KEEPALIVE__\nA2A 端点已启动：${a2aServer.url}（messages/send 快捷通道 + tasks/* 任务流 + /.well-known/agent.json 卡片，仅本机监听，SIGINT 停止；/a2a stop 停止）\n访问令牌（Authorization: Bearer，仅此一次展示）：${a2aServer.token}`;
      } catch (e: any) {
        return `启动失败：端口 ${port} 可能被占用（/a2a serve <其他端口>）——${e?.message?.slice(0, 80)}`;
      }
    }
    if (sub === 'stop') {
      if (!a2aServer) return 'A2A 端点未运行';
      await closeA2a();
      return 'A2A 端点已停止';
    }
    return lines(' A2A ', [
      ' 用法：/a2a call <对端URL> <消息>——调用其他 agent（A2A 协议）',
      '       /a2a serve [端口]——启动本机 A2A 端点（默认 8787）',
      '       /a2a stop——停止端点',
      ' 协议：JSON-RPC messages/send（A2A 规范子集，本地优先）',
    ]);
  });

  // /acp：Agent Client Protocol stdio 服务器（IDE 集成）
  //   交互模式下提示；`wxnodus -p "/acp server"` 启动阻塞式 stdio 会话（Zed/JetBrains 接入）
  bus.register('/acp', async (args) => {
    const wantServer = args[0] === 'server';
    if (!wantServer) {
      return lines(' ACP ', [
        ' Agent Client Protocol（ACP）stdio 服务器——IDE 集成',
        ' 用法：wxnodus -p "/acp server"（阻塞式，供 ACP 客户端启动）',
        ' 协议：initialize → session/new → prompt → assistant 消息',
        ' 参考：Zed / JetBrains 的 ACP 客户端配置',
      ]);
    }
    return 'ACP stdio 服务只支持专用 headless 入口：wxnodus -p "/acp server"';
  });

}
