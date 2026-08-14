#!/usr/bin/env node
// src/cli/index.ts — L6-2 CLI 入口（commander + WxNodus UI 装配）
// 装配：data/config/db/mem/bus/agent → wxGateway（进程内桥接）→ @wxnodus/ink render App

import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { createAutoReview } from '../kernel/autoReview.js';
import { parseCronExpr, parseIntervalExpr, cronMatches } from '../kernel/cronExpr.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { resolveDataDir } from '../kernel/paths.js';
// W3-01：完成终态 → 退出码共享映射（failure 不藏在 exit 0 后面）
import { processExitForCompletion } from '../protocol/completionTransport.js';
// W3-02：wire 入口前端——事件流经纯投影管线，终态走共享 completionTransport（headless，无 React）
import { createWireFrontend } from '../bootstrap/createWireFrontend.js';
// A24 第三类修复：buildInfo system_prompt 数据源（kernel 实时构建；ESM 静态引用缓存）
import { buildSystemPrompt as buildSystemPromptRef } from '../kernel/systemPrompt.js';
import { hasImageIn as hasImageInRef } from '../kernel/providers.js';

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
// --cwd：切换到指定工作目录（数据/会话/项目规范均以该目录为准；Gemini/Codex 同款）
if (opts.cwd) {
  try {
    process.chdir(opts.cwd);
  } catch (e: any) {
    console.error(`wxnodus: --cwd 目录不可用：${e?.message ?? e}`);
    process.exit(1);
  }
}

// W2-01：pre-bootstrap onboarding——首次进入选择系统语言（zh-CN/en）；
// 在 _initErrorLog/mkdirSync/DB/MCP/Plugin/网络/TUI 之前执行（干净环境零副作用）。
const { decidePreBootstrap, readLocaleFile, promptLanguageOnStdio, persistPreBootstrapLocale } = await import('../application/bootstrap/preBootstrapOnboarding.js');
const pre = await decidePreBootstrap({
  argv: process.argv.slice(2),
  env: process.env,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  readWorkspaceLocale: () => readLocaleFile(join(process.cwd(), '.wxnodus', 'config.yaml')),
  readUserLocale: () => readLocaleFile(join(resolveDataDir(process.cwd()), 'config.json')),
  promptLanguage: promptLanguageOnStdio,
  persistUserLocale: locale => persistPreBootstrapLocale(join(resolveDataDir(process.cwd()), 'config.json'), locale),
});
if (pre.mode === 'error') {
  process.stderr.write(`${pre.output ?? 'CONFIG_SCHEMA_INVALID'}\n`);
  process.exitCode = 2;
} else if (pre.mode === 'print-and-exit') {
  process.stdout.write(pre.output === 'version' ? `wxnodus ${VERSION}\n` : `${USAGE}\n`);
  process.exit(0);
} else {
  const locale = pre.locale ?? 'en';
  // 首次安装语言选择完成 → 以所选语言欢迎（选择结果即时可见；后续启动不再提示）
  if (pre.mode === 'onboarding-required') {
    const { translate } = await import('../application/i18n/i18nService.js');
    process.stdout.write(`${translate(locale, 'onboarding.welcome')}\n`);
  }

  async function main() {
    const cwd = process.cwd();
    const dataDir = resolveDataDir(cwd);
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
  // W2-03：统一幂等关闭——全部 disposer 尝试、聚合失败 id（bootstrapShutdown 语义）；
  // serve/keepalive/TUI/SIGINT/SIGTERM 共用同一条关闭路径（此前各分支各写各的 process.exit）。
  const { createShutdown } = await import('../bootstrap/bootstrapShutdown.js');
  const disposers: Array<{ id: string; dispose: (reason: string) => Promise<void> | void }> = [];
  const shutdown = (reason = 'cli') => createShutdown(disposers)(reason);
  disposers.push({ id: 'db', dispose: () => { closeDB(db); } });
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
      settings.model = resolveDefaultModel({});
      config.setKey('settings', 'model', settings.model);
    }
    if (!settings.baseURL) {
      settings.baseURL = resolveDefaultBaseURL({});
      config.setKey('settings', 'baseURL', settings.baseURL);
    }
  }
  let model = settings.model ?? (settings.apiKeyEnc ? resolveDefaultModel({}) : '');

  // 审批桥：agent 工具确认 → GatewayClient.requestApproval（审批 overlay）
  let gateway: any = null;

  // W2-03：--prompt --wire 真实 headless 网关——此前 gateway 恒为 null（TUI 才装配），
  // wire 双向化（stdin 帧 → RPC）与 wire 终态比对静默失效。headless 网关无 React/Ink 依赖，
  // approval/clarify/sudo/secret/form responder 等待 stdin 帧，超时 fail-closed（deny/''/null）。
  if (opts.wire && opts.prompt && !opts.serve) {
    const { createHeadlessWireGateway } = await import('./headlessGateway.js');
    gateway = createHeadlessWireGateway({ sessionId: opts.session ?? 'default' });
  }
  // 会话级批准缓存（Kimi auto_approve_actions 同款）：用户选「Allow this session」的
  // action 记入缓存，本次进程内同 action 自动放行不再弹——危险确认不再频繁
  const { createApprovalCache } = await import('../kernel/permissions.js');
  const approvalCache = createApprovalCache();
  // Hooks：settings.hooks 热生效（每次触发读当前配置），本地命令执行
  const hookRunner = createHookRunner(() => config.get('settings') as Record<string, any>, bus);
  // MCP 客户端（本地 stdio）：项目级 .mcp.json + 用户级 data/mcp.json 合并；
  // strictMcpConfig 开启时仅信任项目声明（生态对齐 Claude Code --strict-mcp-config）
  const { connectAllMcp, mcpClientsToTools, closeAllMcp } = await import('../kernel/mcp.js');
  const mcpOpts = { cwd, strict: (settings as any).strictMcpConfig === true || opts.strictMcpConfig === true };
  let mcpClients = await connectAllMcp(dataDir, mcpOpts);
  disposers.push({ id: 'mcp', dispose: () => { closeAllMcp(mcpClients); } });
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
  // 插件 API 层（阶段 3）：事件订阅（bus）+ 配置只读访问注入插件 ctx
  const plugins = await loadAllPlugins(dataDir, cwd, {
    on: (type, cb) => {
      const off = bus.on(type, (e: any) => { try { cb(e?.payload ?? {}); } catch { /* 插件回调异常不阻断 */ } });
      return off;
    },
    getConfig: (partition, key) => {
      try {
        const obj = config.get(partition as any);
        return key ? (obj as any)?.[key] : obj;
      } catch { return undefined; }
    },
  });
  // P3 安全注入通道：敏感数据内存保险库（sudo 密码/环境变量密钥——用户亲手输入、仅内存、关闭即清）
  const { createSecretVault } = await import('../kernel/secrets.js');
  const secrets = createSecretVault();
  // 开放兼容：只读工具名单由内置工具表自动推导（danger!==true 即只读）——
  // 不再手工双写（旧名单已漂移：幽灵名/缺 find_files），新增工具自动生效
  const { deriveReadonlyTools, setReadonlyTools } = await import('../kernel/permissions.js');
  const { coreTools } = await import('../kernel/tools.js');
  setReadonlyTools(deriveReadonlyTools(coreTools()));
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
    // 动态内容表（credential_form 工具）：经 gateway 弹多字段表单——闭包引用 gateway 变量（装配后可用）
    onFormRequest: async (fields, prompt) => (gateway ? gateway.requestCredentialForm(fields, prompt) : null),
    // 简化人工操作（阶段 C）：smart 模式工作区内文件编辑自动放行（默认开启，/perm 说明）
    lowRiskAutoApprove: (settings as any).lowRiskAutoApprove !== false,
    dataDir,
    toolLazyLoad: (settings as any).toolLazyLoad === true,
    // D 批次：AI 审批预审（settings.autoReview=true 开启）——用主模型单轮判断 allow/deny/ask
    autoReview: createAutoReview(
      () => (settings as any).autoReview === true,
      async (prompt) => {
        // 架构修复：独立单轮调用（callModelOnce）——不再递归 agent.run。
        // 此前递归同一 agent 实例：executeTool 内触发评审 → 覆盖 turn 状态、
        // 相同 sessionId 消息互相污染、轮次计数错乱（竞品 Codex 用独立评审代理）。
        try {
          const { resolveApiKey } = await import('../kernel/providers.js');
          const { resolveDefaultModel, resolveDefaultBaseURL } = await import('../kernel/defaults.js');
          const { callModelOnce } = await import('../kernel/llmOnce.js');
          const keyRes = resolveApiKey(settings);
          if (!keyRes.key) return 'ask';
          const r = await callModelOnce({
            baseURL: resolveDefaultBaseURL(settings),
            model: resolveDefaultModel(settings),
            key: keyRes.key,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            timeoutMs: 30_000,
          });
          return r.ok ? r.content : 'ask';
        } catch {
          return 'ask';
        }
      },
    ),
    hooks: hookRunner,
    extraTools: { ...mcpClientsToTools(mcpClients), ...pluginToolsToExtra(plugins) },
    // AI 自主调用通道（wx_cmd 工具）：闭包引用 commandBus 变量（命令注册在 agent 之后完成，
    // 调用时才求值——与 gateway 同模式）；分级裁决在 agent.executeTool（commandLevels）
    onCommand: async (input) => {
      const r = await commandBus.execute(String(input));
      return r.output || r.dispatch?.message || r.error || (r.ok ? '' : `命令执行失败：${r.error ?? ''}`);
    },
  });

  // 模式/主题状态
  let mode = (config.get('settings') as any).mode ?? 'smart';
  let themeName = (config.get('settings') as any).theme ?? 'wxnodus';
  let exitRequested = false;

  // 并行任务系统（/jobs）：shell 真进程 / agent 子代理 / 并行双线子任务——
  // 与主对话并行（三任务并行：主线 + 双支线）；启动恢复遗留孤儿任务
  const { createTaskRunner } = await import('../kernel/taskRunner.js');
  const taskRunner = createTaskRunner({
    db, bus, dataDir,
    spawnSubagent: (goal) => agent.spawnSubagent(goal),
    maxConcurrent: (settings as any).jobsConcurrency ?? 2,
  });
  taskRunner.recoverOrphans();

  // A20：后台终端（/term）——node-pty 真实交互会话（与 /jobs 一次性执行互补）
  const { createTerminalManager } = await import('../kernel/term.js');
  const term = createTerminalManager({ dataDir, cwd });

  // 命令注册
  const commandBus = createCommandBus();
  // 插件命令注册为 /<插件名>.<命令名>（如 /example.hello），防与内置命令冲突；
  // 同时动态注册进 SLASH 命令表——routeInput 白名单校验与 UI 补全才能识别。
  // 开放兼容：注册逻辑在 plugins.ts（registerPluginCommands），/plugin reload 复用（热更新）
  const { registerPluginCommands, registerPluginNlTriggers } = await import('../kernel/plugins.js');
  registerPluginCommands(commandBus, plugins);
  registerPluginNlTriggers(plugins);
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
    dataDir, cwd, db, mem, config, bus, commandBus,
    agent,
    getModel: () => model,
    getMode: () => mode,
    setMode: (m: string) => { mode = m; agent.setMode(m as any); config.setKey('settings', 'mode', m); },
    setTheme: (t: string) => { themeName = t; config.setKey('settings', 'theme', t); },
    getThemeName: () => themeName,
    requestExit: () => { exitRequested = true; void shutdown('request-exit').finally(() => process.exit(0)); },
    clearHistory: () => { /* UI 历史清理由 App 层处理 */ },
    setModel: applyModel,
    openModelPicker: () => { /* WxNodus UI: /model 打开选择器 */ },
    openSessions: () => { /* WxNodus UI: /sessions 打开列表 */ },
    setThinking: (on: boolean) => { config.setKey('settings', 'thinking', on); },
    reloadMcp,
    secrets,
    // 并行任务系统（/jobs：shell 真进程 / agent 子代理 / 并行双线子任务）
    taskRunner,
    // A20：后台终端（/term：node-pty 交互会话）
    term,
    // getter：gateway 在 TUI 装配后赋值——命令执行时动态读取（注册时快照为 null 的坑）
    get gateway() { return gateway; },
  });
  registerCoreHandlers(commandBus, makeHandlerCtx());
  registerExtHandlers(commandBus, makeHandlerCtx());

  // 黑洞策展后台自动审查（机制补强）：启动 5s 后检查间隔，超期则后台执行一轮
  setTimeout(() => {
    import('../kernel/curator.js').then(({ maybeRunCurator }) => {
      maybeRunCurator({ getSettings: () => config.get('settings') as Record<string, any>, mem, dataDir, cwd, bus });
    }).catch(() => { /* 后台审查失败静默 */ });
  }, 5000);

  // P1-4：冷启动预热——后台加载记忆 embedder（transformers.js 首次加载 ~10s）。
  // 首个 /hole、/memory search 或 agent 自动召回不再白等；失败静默（下次调用再加载）。
  // 仅常驻模式预热（-p 单次执行毫秒级退出，预热无意义）。
  if (!opts.prompt && !opts.serve && !opts.wire) {
    setTimeout(() => {
      void (async () => {
        try { await mem.recallHybrid('预热', { limit: 1 }); } catch { /* 静默 */ }
      })();
    }, 0);
  }

  // 定时任务调度（对比轮 6：/cron 真实执行）——每分钟检查到期任务，后台派发 agent 执行
  // 支持标准 5 字段 cron（分 时 日 月 周）与 every Ns/Nm/Nh/Nd 间隔格式（cronExpr.ts 解析）
  setInterval(() => {
    try {
      const jobs = db.prepare(`SELECT * FROM cron_jobs WHERE enabled=1`).all() as Array<{ id: number; schedule: string; action: string; last_run: number | null }>;
      const now = Date.now();
      for (const j of jobs) {
        const schedule = String(j.schedule ?? '');
        const interval = parseIntervalExpr(schedule);
        if (interval) {
          if (j.last_run && now - j.last_run < interval.intervalMs) continue;
        } else {
          // 标准 cron 表达式：按字段匹配当前分钟
          const r = parseCronExpr(schedule);
          if (!r.ok) continue;
          if (!cronMatches(r.fields, new Date(now))) continue;
          if (j.last_run && now - j.last_run < 60_000) continue; // 分钟级去重
        }
        db.prepare(`UPDATE cron_jobs SET last_run=? WHERE id=?`).run(now, j.id);
        bus.emit('system.notice', { text: `定时任务 #${j.id} 触发：${String(j.action).slice(0, 60)}` });
        // 投递任务系统（agent 型独立会话）——不再用主 agent.run，避免与用户对话抢占上下文；
        // 执行结果落 tasks 表（tag=cron:<id>），/jobs list --tag cron:1 可查
        taskRunner.run({
          goal: `（定时任务 #${j.id}）${j.action}`,
          kind: 'agent',
          tags: [`cron:${j.id}`],
          maxRetries: 1,
        });
      }
    } catch { /* 任务表未就绪静默 */ }
  }, 10_000);

  // P2-3：cron 结果回执——定时任务（tags 含 cron:<id>）完成时系统通知，
  // 用户不再需要主动 /jobs 查询才知道后台定时任务的结果
  bus.on('jobs.complete', (e: any) => {
    try {
      const row = db.prepare(`SELECT tags FROM tasks WHERE id=?`).get(e?.payload?.id) as { tags: string } | undefined;
      const cronId = /cron:(\d+)/.exec(String(row?.tags ?? ''))?.[1];
      if (!cronId) return;
      const status = e?.payload?.status;
      const icon = status === 'success' ? '✅' : '⚠️';
      bus.emit('system.notice', {
        text: `${icon} 定时任务 #${cronId} ${status === 'success' ? '已完成' : `失败（${status ?? '未知'}）`}——/jobs show ${e?.payload?.id} 查看结果`,
      });
    } catch { /* 回执失败静默 */ }
  });

  // AI 网关模式（颠覆性改造）：wxnodus --serve —— 本地 HTTP 服务，
  // 多前端共享同一 agent/记忆/权限面（IDE 插件/浏览器/第二个终端等）
  if (opts.serve) {
    const { startServeServer } = await import('./serve.js');
    const port = opts.port ?? Number(process.env.WXNODUS_SERVE_PORT ?? 4789);
    const srv = startServeServer({
      dataDir, cwd, db, bus, mem, agent,
      commandBus,
      config,
    }, port);
    disposers.push({ id: 'serve', dispose: async () => { await srv.close(); } });
    console.log(`◉ WxNodus AI 网关已启动：http://127.0.0.1:${srv.port}`);
    console.log(`  GET  /health/live  存活探针（无认证）｜ GET /health /rpc /events 需 Bearer（WXNODUS_SERVE_TOKEN）`);
    console.log('  Ctrl+C 停止');
    // W2-03：SIGINT/SIGTERM 走统一幂等关闭（不再分支各自 process.exit）
    process.on('SIGINT', () => { void shutdown('sigint').finally(() => process.exit(0)); });
    process.on('SIGTERM', () => { void shutdown('sigterm').finally(() => process.exit(0)); });
    // 常驻等待（事件循环由 HTTP server 保持）
    await new Promise<void>(() => {});
    return;
  }

  // 非交互模式
  if (opts.prompt) {
    const text = String(opts.prompt);
    // --session：切换到指定会话（此前仅 usage 查询使用，agent 未切换——审计修复）
    if (opts.session) {
      agent.setSessionId(opts.session);
      gateway.bindSession?.(opts.session);
    }
    // --ephemeral：临时会话（Codex 对齐）——不加载历史、结束后清理（消息/快照），不污染会话列表
    const ephemeralSid = opts.ephemeral ? `ephemeral-${Date.now().toString(36)}` : null;
    if (ephemeralSid) agent.setSessionId(ephemeralSid);
    const cleanupEphemeral = () => {
      if (!ephemeralSid) return;
      try {
        db.prepare(`DELETE FROM messages WHERE session_id=?`).run(ephemeralSid);
        db.prepare(`DELETE FROM checkpoints WHERE session_id=?`).run(ephemeralSid);
        db.prepare(`DELETE FROM sessions WHERE id=?`).run(ephemeralSid);
      } catch { /* 清理失败静默 */ }
    };
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
      // W3-02：wire 入口前端——gateway 事件流经纯投影管线，终态上报与共享表比对（漂移即 FRONTEND_COMPLETION_MISMATCH）
      const frontend = gateway ? createWireFrontend(gateway) : null;
      const result = await agent.run(text);
      const wireStatus = result.interrupted ? 'cancelled' as const : result.ok ? 'succeeded' as const : 'failed' as const;
      const completion = frontend?.complete(wireStatus, { wireFinal: wireStatus });
      console.log(JSON.stringify({ type: 'agent.result', ok: result.ok, text: result.text, turns: result.turns, interrupted: result.interrupted,
        wireFinal: completion && !completion.ok ? 'FRONTEND_COMPLETION_MISMATCH' : wireStatus }));
      for (const off of offs) off();
      frontend?.dispose();
      cleanupEphemeral();
      process.exit(processExitForCompletion(completion && !completion.ok ? 'failed' : wireStatus));
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
          // W2-03 修复：此前引用 TUI 分支才定义的 shutdown（TDZ ReferenceError——headless
          // keepalive 路径永不执行 TUI 装配）。现走共享统一关闭。
          process.once('SIGINT', () => { void shutdown('sigint').finally(resolve); });
          process.once('SIGTERM', () => { void shutdown('sigterm').finally(resolve); });
        });
      } else {
        console.log(out);
      }
      // 审查修复：命令分支退出码遵循 P1-2 协议（0 成功｜1 失败）——此前恒 0，
      // 命令失败/未知命令 CI 无法感知；agent 分支已正确用 r.ok 决定
      // W3-01：退出码改走共享 completionTransport 映射（failed → 1），与 HTTP/wire 口径一致
      if (!r.ok) {
        cleanupEphemeral();
        process.exit(processExitForCompletion('failed'));
      }
    } else if (routed.kind === 'tool' && routed.value) {
      console.log(routed.value);
    } else {
      try {
        const result = await agent.run(text);
        if (opts.json) {
          // Gemini --output-format json 的 stats 对齐：usage 为会话累计 token
          let usage: number | null = null;
          try {
            const row = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens),0) t FROM usage_stats WHERE session_id=?`).get(opts.session ?? 'default') as { t: number } | undefined;
            usage = row?.t ?? null;
          } catch { /* 统计失败静默 */ }
          // --output-schema：输出结构校验（claude --json-schema / codex --output-schema 对齐）——
          // 校验失败报错并给退出码 1（诚实：不静默交付不符合结构的输出）
          if (opts.outputSchema) {
            const { validateJsonSchema } = await import('../kernel/jsonSchema.js');
            try {
              const schema = JSON.parse(opts.outputSchema);
              const parsed = JSON.parse(result.text);
              const violations = validateJsonSchema(parsed, schema);
              if (violations.length) {
                process.stderr.write(`wxnodus: 输出不符合 --output-schema：\n${violations.slice(0, 5).map(v => `  ${v.path || '(根)'}：${v.message}`).join('\n')}\n`);
                cleanupEphemeral();
                process.exit(1);
              }
            } catch (e: any) {
              process.stderr.write(`wxnodus: --output-schema 校验异常：${String(e?.message ?? e).slice(0, 120)}\n`);
              cleanupEphemeral();
              process.exit(1);
            }
          }
          console.log(JSON.stringify({ ok: result.ok, text: result.text, turns: result.turns, interrupted: result.interrupted, usage }));
        } else {
          console.log(result.text);
        }
        // P1-2 退出码协议：0 成功｜1 失败（-p 分支）——W3-01 起走共享 completionTransport（interrupted → cancelled 130）
        cleanupEphemeral();
        process.exit(processExitForCompletion(result.interrupted ? 'cancelled' : result.ok ? 'succeeded' : 'failed'));
      } catch (e: any) {
        // P1-2：可重试失败（429/5xx/网络/超时）→ 75（EX_TEMPFAIL），CI 据此重试
        const { exitCodeForError } = await import('../kernel/errors.js');
        process.stderr.write(`wxnodus: ${e?.message ?? e}
`);
        cleanupEphemeral();
        process.exit(exitCodeForError(e));
      }
    }
    cleanupEphemeral();
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

  // A24 第三类修复：落后上游提交数——git rev-list 真实计算（无 git/无 upstream → null）
  // 启动时一次计算（buildInfo 高频读取，避免每次 spawn git）；纯本地引用对比，不发起网络
  let updateBehind: number | null = null
  try {
    const { execFileSync: gitExec } = await import('node:child_process');
    const branch = String(gitExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 })).trim()
    if (branch && branch !== 'HEAD') {
      const ahead = gitExec('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 })
      updateBehind = Number(String(ahead).trim()) || null
    }
  } catch { /* 非 git 仓库/无 origin 时保持 null——诚实降级 */ }

  // WxNodus UI 装配
  gateway = new GatewayClient({
    bus, db, config, mem, agent, commandBus,
    dataDir, cwd, settings, reloadMcp, updateBehind,
    // A24 第三类修复：MCP 服务器真实状态（连接/工具数/传输方式）——buildInfo 填充 mcp_servers
    mcpStatus: () => mcpClients.map(c => ({
      connected: c.connected,
      name: c.server.name,
      tools: c.tools.length,
      transport: c.server.url ? 'http' : 'stdio',
    })),
    // A24 第三类修复：当前系统提示词（kernel buildSystemPrompt 实时构建，外部 system.md 热生效）——buildInfo 填充 system_prompt
    systemPrompt: () => {
      try {
        return buildSystemPromptRef({
          mode: mode as any,
          cwd,
          model: model || settings.model || '',
          hasImageIn: hasImageInRef(model || settings.model || ''),
          sessionId: agent.getSessionId?.() ?? 'default',
          lang: (settings as any).lang,
          locale,
          dataDir,
        });
      } catch { return undefined; }
    },
    applyModel,
    setMode: (m: string) => { mode = m; agent.setMode(m as any); config.setKey('settings', 'mode', m); },
    setTheme: (t: string) => { themeName = t; config.setKey('settings', 'theme', t); },
    setThinking: (on: boolean) => { config.setKey('settings', 'thinking', on); },
    requestExit: () => { exitRequested = true; void shutdown('request-exit').finally(() => process.exit(0)); },
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
  // B1/W2-03 统一退出清理：MCP 子进程 + DB + UI 全部回收（SIGINT/SIGTERM/requestExit 共用
  // main 顶部定义的共享幂等 shutdown——聚合全部 disposer 失败，不再各分支手写 process.exit）
  disposers.push({ id: 'ui', dispose: () => { app?.unmount(); } });

  process.on('SIGINT', () => {
    if (exitRequested) { void shutdown('sigint').finally(() => process.exit(0)); return; }
    exitRequested = true;
    gateway.kill('SIGINT');
    agent.abort();
    setTimeout(() => { void shutdown('sigint').finally(() => process.exit(0)); }, 300);
  });
  process.on('SIGTERM', () => { void shutdown('sigterm').finally(() => process.exit(0)); });
}

main().catch(e => { console.error('启动失败：', e?.message ?? e); process.exit(1); });
}
