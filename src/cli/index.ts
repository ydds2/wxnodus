#!/usr/bin/env node
// src/cli/index.ts — L6-2 CLI 入口（commander + WxNodus UI 装配）
// 装配：data/config/db/mem/bus/agent → wxGateway（进程内桥接）→ @wxnodus/ink render App
import { Command } from 'commander';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const VERSION = '3.0.0';
// 调试：捕获未处理异常/拒绝（React 渲染错误会冒泡至此）
if (!process.env.WXNODUS_NO_DEBUG) {
  import('node:fs').then(({ appendFileSync }) => {
    process.on('uncaughtException', (e) => { try { appendFileSync('wxerr.log', `uncaught: ${(e as Error)?.stack ?? e}\n`); } catch {} });
    process.on('unhandledRejection', (e: any) => { try { appendFileSync('wxerr.log', `unhandled: ${e?.stack ?? e}\n`); } catch {} });
    const origErr = console.error;
    console.error = (...args: any[]) => {
      try { appendFileSync('wxerr.log', `console.error: ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a) ?? String(a)).join(' ')}\n`); } catch {}
      origErr(...args);
    };
  });
}
const program = new Command();
program.name('wxnodus').version(VERSION).description('WxNodus V3 — 本地概念编译器 CLI');
program.option('-p, --prompt <text>', '非交互单次执行');
program.option('--json', '-p 模式下 agent 结果输出 JSON（{ok,text,turns,interrupted}）');
program.option('--wire', '-p 模式下输出总线事件流（JSONL：agent.start/token/message/tool/end/error）');
program.parse(process.argv);
const opts = program.opts();


async function main() {
  const cwd = process.cwd();
  const dataDir = join(cwd, 'data');
  mkdirSync(dataDir, { recursive: true });

  const [{ createConfig }, { openDB }, { createEventBus }, { createMemory }, { createAgent }, { createCommandBus }, { createHookRunner }, { GatewayClient }] = await Promise.all([
    import('../store/config.js'),
    import('../store/db.js'),
    import('../kernel/events.js'),
    import('../kernel/memory.js'),
    import('../kernel/agent.js'),
    import('../app/CommandBus.js'),
    import('../kernel/hooks.js'),
    import('../wxnodus-ui/wxGateway.js'),
  ]);

  const config = createConfig(dataDir);
  const db = openDB(dataDir);
  const bus = createEventBus(dataDir);
  const mem = createMemory(db);
  const settings = config.get('settings') as { apiKeyEnc?: string; model?: string; baseURL?: string; mode?: string; theme?: string; thinking?: boolean };
  // 默认模型/端点兜底：/key 只保存密钥时，若 config 无 model/baseURL，
  // agent 的 defaultCallModel 会因 `!s.model || !s.baseURL` 降级规则脑
  // （提示「未配置」）——有 key 即视为已配置，补齐默认值并持久化。
  // 同时校验 model 必须是合法 modelId：遗留数据可能把 UI 命令串
  // （"deepseek-reasoner --provider deepseek"）写进 model 字段，
  // 会导致 API 请求模型名非法而失败。
  if (settings.apiKeyEnc) {
    const { MODEL_CATALOG } = await import('../kernel/providers.js');
    if (!settings.model || !MODEL_CATALOG.some(m => m.modelId === settings.model)) {
      settings.model = 'deepseek-v4-flash';
      config.setKey('settings', 'model', settings.model);
    }
    if (!settings.baseURL) { settings.baseURL = 'https://api.deepseek.com/v1'; config.setKey('settings', 'baseURL', settings.baseURL); }
  }
  let model = settings.model ?? (settings.apiKeyEnc ? 'deepseek-v4-flash' : '');

  // 审批桥：agent 工具确认 → GatewayClient.requestApproval（审批 overlay）
  let gateway: any = null;
  // Hooks：settings.hooks 热生效（每次触发读当前配置），本地命令执行
  const hookRunner = createHookRunner(() => config.get('settings') as Record<string, any>, bus);
  // MCP 客户端（本地 stdio）：data/mcp.json 配置的 server 动态并入工具表
  const { connectAllMcp, mcpClientsToTools, closeAllMcp } = await import('../kernel/mcp.js');
  const mcpClients = await connectAllMcp(dataDir);
  const agent = createAgent({
    db, bus, mem, sessionId: 'default', config: { settings },
    mode: (config.get('settings') as any).mode ?? 'smart',
    onApproval: async (name, args) => gateway ? gateway.requestApproval(name, args) : false,
    hooks: hookRunner,
    extraTools: mcpClientsToTools(mcpClients),
  });

  // 模式/主题状态
  let mode = (config.get('settings') as any).mode ?? 'smart';
  let themeName = (config.get('settings') as any).theme ?? 'kimi';
  let thinking = (config.get('settings') as any).thinking ?? true;
  let exitRequested = false;

  // 命令注册
  const commandBus = createCommandBus();
  const { registerCoreHandlers } = await import('../commands/handlers.js');
  const { registerExtHandlers } = await import('../commands/handlersExt.js');

  // 模型热切换：agent 持有 settings 对象引用——改内存字段即生效，再持久化
  const applyModel = (modelId: string, baseURL?: string) => {
    settings.model = modelId;
    if (baseURL) settings.baseURL = baseURL;
    config.setKey('settings', 'model', modelId);
    if (baseURL) config.setKey('settings', 'baseURL', baseURL);
    model = modelId;
  };
  const makeHandlerCtx = () => ({
    dataDir, cwd, db, mem, config, bus,
    agent,
    getModel: () => model,
    getMode: () => mode,
    setMode: (m: string) => { mode = m; agent.setMode(m as any); config.setKey('settings', 'mode', m); },
    setTheme: (t: string) => { themeName = t; config.setKey('settings', 'theme', t); },
    getThemeName: () => themeName,
    requestExit: () => { exitRequested = true; setTimeout(() => process.exit(0), 50); },
    clearHistory: () => { /* UI 历史清理由 App 层处理 */ },
    setModel: applyModel,
    openModelPicker: () => { /* WxNodus UI: /model 打开选择器 */ },
    openSessions: () => { /* WxNodus UI: /sessions 打开列表 */ },
    setThinking: (on: boolean) => { thinking = on; config.setKey('settings', 'thinking', on); },
  });
  registerCoreHandlers(commandBus, makeHandlerCtx());
  registerExtHandlers(commandBus, makeHandlerCtx());

  // 黑洞策展后台自动审查（机制补强）：启动 5s 后检查间隔，超期则后台执行一轮
  setTimeout(() => {
    import('../kernel/curator.js').then(({ maybeRunCurator }) => {
      maybeRunCurator({ getSettings: () => config.get('settings') as Record<string, any>, mem, dataDir, cwd, bus });
    }).catch(() => { /* 后台审查失败静默 */ });
  }, 5000);

  // 非交互模式
  if (opts.prompt) {
    const text = String(opts.prompt);
    // --wire：订阅总线输出 JSONL 事件流（协议化接口，供外部工具/CI 消费）
    if (opts.wire) {
      const WIRE_EVENTS = new Set(['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'system.notice']);
      const offs: Array<() => void> = [];
      for (const type of WIRE_EVENTS) {
        offs.push(bus.on(type, (e: any) => {
          const line = { type, ...(e?.payload ?? {}) };
          console.log(JSON.stringify(line));
        }));
      }
      const result = await agent.run(text);
      console.log(JSON.stringify({ type: 'agent.result', ok: result.ok, text: result.text, turns: result.turns, interrupted: result.interrupted }));
      for (const off of offs) off();
      process.exit(0);
    }
    const { routeInput } = await import('../commands/intent.js');
    const routed = await routeInput(text);
    if (routed.kind === 'command' && routed.cmd) {
      const r = await commandBus.execute(routed.cmd + (routed.value ? ' ' + routed.value : ''));
      const out = r.output || r.dispatch?.message || r.error || '';
      // __KEEPALIVE__ 前缀：常驻服务命令（/gateway start、/a2a serve）不退出，SIGINT 停止
      if (out.startsWith('__KEEPALIVE__')) {
        console.log(out.slice(14).trim());
        await new Promise<void>(resolve => {
          process.once('SIGINT', () => resolve());
          process.once('SIGTERM', () => resolve());
        });
      } else {
        console.log(out);
      }
    } else if (routed.kind === 'tool' && routed.value) {
      console.log(routed.value);
    } else {
      const result = await agent.run(text);
      if (opts.json) {
        console.log(JSON.stringify({ ok: result.ok, text: result.text, turns: result.turns, interrupted: result.interrupted }));
      } else {
        console.log(result.text);
      }
    }
    process.exit(0);
  }

  if (!process.stdout.isTTY) {
    console.log('wxnodus: 非 TTY 环境，请使用 -p 非交互模式');
    process.exit(0);
  }

  // Windows cmd 编码修复：默认代码页 936(GBK) 下 UTF-8 边框/中文会乱码——
  // 交互启动时切换到 UTF-8(65001) 并设置终端标题（Kimi/Claude Code 同款处理）
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('node:child_process');
      execSync('chcp 65001 >nul', { stdio: 'ignore' });
    } catch { /* 无权限/非 cmd 时静默 */ }
  }
  try { process.stdout.write('\x1b]0;WxNodus — 概念编译器\x07'); } catch {}

  // WxNodus UI 装配
  gateway = new GatewayClient({
    bus, db, config, mem, agent, commandBus,
    dataDir, cwd, settings,
    applyModel,
    setMode: (m: string) => { mode = m; agent.setMode(m as any); config.setKey('settings', 'mode', m); },
    setTheme: (t: string) => { themeName = t; config.setKey('settings', 'theme', t); },
    setThinking: (on: boolean) => { thinking = on; config.setKey('settings', 'thinking', on); },
    requestExit: () => { exitRequested = true; setTimeout(() => process.exit(0), 50); },
  });
  gateway.start();

  const { App } = await import('../wxnodus-ui/app.js');
  const { render } = await import('@wxnodus/ink');
  const React = (await import('react')).default;

  if (process.env.WXNODUS_DEBUG_EVENTS) {
    process.stdout.write('[boot] rendering App\n')
  }
  let app: any = null
  try {
    app = render(React.createElement(App, { gw: gateway }), { exitOnCtrlC: false })
  } catch (e: any) {
    if (process.env.WXNODUS_DEBUG_EVENTS) process.stdout.write('[boot] render FAILED: ' + String(e?.message ?? e).slice(0, 200) + '\n')
    throw e
  }

  // Ctrl+C：运行中中断 / 空闲退出
  process.on('SIGINT', () => {
    if (exitRequested) { try { app?.unmount(); } catch {} process.exit(0); }
    exitRequested = true;
    gateway.kill('SIGINT');
    agent.abort();
    setTimeout(() => { try { app?.unmount(); } catch {} process.exit(0); }, 300);
  });
  process.on('SIGTERM', () => { try { app?.unmount(); } catch {} process.exit(0); });
}

main().catch(e => { console.error('启动失败：', e?.message ?? e); process.exit(1); });
