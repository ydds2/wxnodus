#!/usr/bin/env node
// src/cli/index.ts — L6-2 CLI 入口（commander + WxNodus UI 装配）
// 装配：data/config/db/mem/bus/agent → wxGateway（进程内桥接）→ @wxnodus/ink render App

import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { createAutoReview } from '../kernel/autoReview.js';

const VERSION = '3.0.0';
// 调试：捕获未处理异常/拒绝 → dataDir/logs/error-<日期>.log（统一日志目录，不污染工作目录）
// dataDir 在 main 内定义——日志初始化延迟到装配时调用（见 _initErrorLog）
let _initErrorLog: (dir: string) => void = () => {};
if (!process.env.WXNODUS_NO_DEBUG) {
  _initErrorLog = (dir: string) => {
    try {
      const logDir = join(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const logFile = () => join(logDir, `error-${new Date().toISOString().slice(0, 10)}.log`);
      const write = (tag: string, e: unknown) => {
        try { appendFileSync(logFile(), `[${new Date().toISOString()}] ${tag}: ${(e as Error)?.stack ?? String(e)}\n`); } catch {}
      };
      process.on('uncaughtException', (e) => write('uncaught', e));
      process.on('unhandledRejection', (e: any) => write('unhandled', e));
      const origErr = console.error;
      console.error = (...args: any[]) => {
        write('console.error', args.map(a => typeof a === 'string' ? a : JSON.stringify(a) ?? String(a)).join(' '));
        origErr(...args);
      };
    } catch { /* 日志初始化失败不阻断启动 */ }
  };
}
// A 批次：自研参数解析（替代 commander，零依赖）
const { parseArgs, USAGE } = await import('./args.js');
const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(USAGE); process.exit(0); }
if (opts.version) { console.log(`wxnodus ${VERSION}`); process.exit(0); }


async function main() {
  const cwd = process.cwd();
  const dataDir = join(cwd, 'data');
  _initErrorLog(dataDir);
  mkdirSync(dataDir, { recursive: true });

  const [{ createConfig }, { openDB, closeDB }, { createEventBus }, { createMemory }, { createAgent }, { createCommandBus }, { createHookRunner }, { GatewayClient }] = await Promise.all([
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
  // 会话级批准缓存（Kimi auto_approve_actions 同款）：用户选「Allow this session」的
  // action 记入缓存，本次进程内同 action 自动放行不再弹——危险确认不再频繁
  const { createApprovalCache } = await import('../kernel/permissions.js');
  const approvalCache = createApprovalCache();
  // Hooks：settings.hooks 热生效（每次触发读当前配置），本地命令执行
  const hookRunner = createHookRunner(() => config.get('settings') as Record<string, any>, bus);
  // MCP 客户端（本地 stdio）：项目级 .mcp.json + 用户级 data/mcp.json 合并；
  // strictMcpConfig 开启时仅信任项目声明（生态对齐 Claude Code --strict-mcp-config）
  const { connectAllMcp, mcpClientsToTools, closeAllMcp } = await import('../kernel/mcp.js');
  const mcpOpts = { cwd, strict: (settings as any).strictMcpConfig === true };
  let mcpClients = await connectAllMcp(dataDir, mcpOpts);
  // MCP 热重载（/reload-mcp）：断开 → 重连 → updateTools 热换工具表（不重启进程）
  const reloadMcp = async (): Promise<{ ok: boolean; count: number; message: string }> => {
    try {
      closeAllMcp(mcpClients);
      const clients = await connectAllMcp(dataDir, mcpOpts);
      mcpClients = clients;
      agent.updateTools({ ...mcpClientsToTools(mcpClients), ...pluginToolsToExtra(plugins) });
      return { ok: true, count: clients.length, message: `MCP 服务器已重载（${clients.length} 个在线）` };
    } catch (e: any) {
      return { ok: false, count: 0, message: `MCP 重载失败：${String(e?.message ?? e).slice(0, 120)}` };
    }
  };
  // 插件系统（P0）：data/plugins/*/ 加载 → 工具并入 extraTools（命令注册在 commandBus 创建后）
  const { loadAllPlugins, pluginToolsToExtra } = await import('../kernel/plugins.js');
  const plugins = await loadAllPlugins(dataDir, cwd);
  // P3 安全注入通道：敏感数据内存保险库（sudo 密码/环境变量密钥——用户亲手输入、仅内存、关闭即清）
  const { createSecretVault } = await import('../kernel/secrets.js');
  const secrets = createSecretVault();
  const agent = createAgent({
    db, bus, mem, sessionId: 'default', config: { settings },
    mode: (config.get('settings') as any).mode ?? 'smart',
    onApproval: async (name, args) => {
      if (approvalCache.has(name, args)) return true; // 本会话已批准（Allow this session）
      if (!gateway) return false;
      const choice = await gateway.requestApproval(name, args);
      if (choice === 'session') approvalCache.grant(name, args);
      return choice !== 'deny';
    },
    // C6：clarify 文字提问（UI clarify 面板真实回答）
    onClarify: async (question, choices) => (gateway ? gateway.requestClarify(question, choices) : ''),
    // P3 安全注入：敏感输入走 UI overlay（用户亲手输入）；非交互/未装配时返回 null（工具拒绝并提示）
    security: {
      sudoInjection: (settings as any).security?.sudoInjection === true,
      secretInjection: (settings as any).security?.secretInjection === true,
      vault: secrets,
    },
    onSecretRequest: async (kind, prompt, name) => (gateway ? gateway.requestSecretInput(kind, prompt, name) : null),
    // 简化人工操作（阶段 C）：smart 模式工作区内文件编辑自动放行（默认开启，/perm 说明）
    lowRiskAutoApprove: (settings as any).lowRiskAutoApprove !== false,
    dataDir,
    toolLazyLoad: (settings as any).toolLazyLoad === true,
    // D 批次：AI 审批预审（settings.autoReview=true 开启）——用主模型单轮判断 allow/deny/ask
    autoReview: createAutoReview(
      () => (settings as any).autoReview === true,
      async (prompt) => {
        const r = await agent.run(`（安全预审任务）请直接回答审查结论：${prompt}`);
        return r.ok ? r.text : 'ask';
      },
    ),
    hooks: hookRunner,
    extraTools: { ...mcpClientsToTools(mcpClients), ...pluginToolsToExtra(plugins) },
  });

  // 模式/主题状态
  let mode = (config.get('settings') as any).mode ?? 'smart';
  let themeName = (config.get('settings') as any).theme ?? 'wxnodus';
  let thinking = (config.get('settings') as any).thinking ?? true;
  let exitRequested = false;

  // 命令注册
  const commandBus = createCommandBus();
  // 插件命令注册为 /<插件名>.<命令名>（如 /example.hello），防与内置命令冲突；
  // 同时动态注册进 SLASH 命令表——routeInput 白名单校验与 UI 补全才能识别
  const { SLASH, COMMAND_DESC } = await import('../commands/registry.js');
  for (const p of plugins) {
    for (const [cmdName, fn] of Object.entries(p.commands)) {
      const full = `/${p.manifest.name}.${cmdName}`;
      commandBus.register(full, (args) => Promise.resolve(fn(args)));
      if (!SLASH.includes(full)) {
        SLASH.push(full);
        COMMAND_DESC[full] = `插件命令（${p.manifest.name}）`;
      }
    }
  }
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
    reloadMcp,
    secrets,
  });
  registerCoreHandlers(commandBus, makeHandlerCtx());
  registerExtHandlers(commandBus, makeHandlerCtx());

  // 黑洞策展后台自动审查（机制补强）：启动 5s 后检查间隔，超期则后台执行一轮
  setTimeout(() => {
    import('../kernel/curator.js').then(({ maybeRunCurator }) => {
      maybeRunCurator({ getSettings: () => config.get('settings') as Record<string, any>, mem, dataDir, cwd, bus });
    }).catch(() => { /* 后台审查失败静默 */ });
  }, 5000);

  // 定时任务调度（对比轮 6：/cron 真实执行）——每分钟检查到期任务，后台派发 agent 执行
  setInterval(() => {
    try {
      const jobs = db.prepare(`SELECT * FROM cron_jobs WHERE enabled=1`).all() as Array<{ id: number; schedule: string; action: string; last_run: number | null }>;
      const now = Date.now();
      for (const j of jobs) {
        const m = /every (\d+)m/.exec(j.schedule ?? '');
        if (!m) continue;
        const intervalMs = parseInt(m[1]!, 10) * 60_000;
        if (j.last_run && now - j.last_run < intervalMs) continue;
        db.prepare(`UPDATE cron_jobs SET last_run=? WHERE id=?`).run(now, j.id);
        bus.emit('system.notice', { text: `定时任务 #${j.id} 触发：${String(j.action).slice(0, 60)}` });
        void agent.run(`（定时任务 #${j.id}）${j.action}`).catch(() => { /* 执行失败不阻断调度 */ });
      }
    } catch { /* 任务表未就绪静默 */ }
  }, 60_000);

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
      // --wire 双向化（P1）：stdin 接收 JSONL 请求帧 → gateway RPC 分发——
      // 外部工具/CI 可应答 approval.respond / clarify.respond / sudo.respond / secret.respond
      // 帧格式：{"method":"approval.respond","params":{"request_id":"…","answer":"allow"}}
      if (gateway) {
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const frame = (() => { try { return JSON.parse(line); } catch { return null; } })();
          if (!frame?.method || typeof frame.method !== 'string') return;
          const params = (frame.params ?? {}) as Record<string, unknown>;
          void gateway.request(frame.method, params).then((r: any) => {
            if (r && typeof r === 'object') console.log(JSON.stringify({ type: 'wire.response', method: frame.method, ...r }));
          }).catch(() => {});
        });
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
          process.once('SIGINT', () => { shutdown(); resolve(); });
          process.once('SIGTERM', () => { shutdown(); resolve(); });
        });
      } else {
        console.log(out);
      }
    } else if (routed.kind === 'tool' && routed.value) {
      console.log(routed.value);
    } else {
      try {
        const result = await agent.run(text);
        if (opts.json) {
          console.log(JSON.stringify({ ok: result.ok, text: result.text, turns: result.turns, interrupted: result.interrupted }));
        } else {
          console.log(result.text);
        }
        // P1-2 退出码协议：0 成功｜1 失败（-p 分支）
        process.exit(result.ok ? 0 : 1);
      } catch (e: any) {
        // P1-2：可重试失败（429/5xx/网络/超时）→ 75（EX_TEMPFAIL），CI 据此重试
        const { exitCodeForError } = await import('../kernel/errors.js');
        process.stderr.write(`wxnodus: ${e?.message ?? e}
`);
        process.exit(exitCodeForError(e));
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

  // 简化人工操作（阶段 C）：启动自动恢复上次未完成会话（settings.autoResume=false 关闭）
  if ((settings as any).autoResume !== false) {
    const { pickResumeSession } = await import('../store/db.js');
    const resumeId = pickResumeSession(db);
    if (resumeId) {
      agent.setSessionId(resumeId);
      bus.emit('system.notice', { text: `已自动恢复上次未完成会话 ${resumeId.slice(0, 8)}…（/new 可开始新会话）` });
    }
  }

  // WxNodus UI 装配
  gateway = new GatewayClient({
    bus, db, config, mem, agent, commandBus,
    dataDir, cwd, settings, reloadMcp,
    applyModel,
    setMode: (m: string) => { mode = m; agent.setMode(m as any); config.setKey('settings', 'mode', m); },
    setTheme: (t: string) => { themeName = t; config.setKey('settings', 'theme', t); },
    setThinking: (on: boolean) => { thinking = on; config.setKey('settings', 'thinking', on); },
    requestExit: () => { exitRequested = true; shutdown(); setTimeout(() => process.exit(0), 50); },
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
  // B1 统一退出清理：MCP 子进程 + DB + UI 全部回收（SIGINT/SIGTERM/requestExit 共用）
  let shutdownDone = false;
  const shutdown = () => {
    if (shutdownDone) return;
    shutdownDone = true;
    try { closeAllMcp(mcpClients); } catch {}
    try { closeDB(db); } catch {}
    try { app?.unmount(); } catch {}
  };

  process.on('SIGINT', () => {
    if (exitRequested) { shutdown(); process.exit(0); }
    exitRequested = true;
    gateway.kill('SIGINT');
    agent.abort();
    setTimeout(() => { shutdown(); process.exit(0); }, 300);
  });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
}

main().catch(e => { console.error('启动失败：', e?.message ?? e); process.exit(1); });
