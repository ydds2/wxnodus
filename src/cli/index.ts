#!/usr/bin/env node
// src/cli/index.ts — L6-2 CLI 入口（commander + WxNodus UI 装配）
// 装配：data/config/db/mem/bus/agent → wxGateway（进程内桥接）→ @wxnodus/ink render App

import { join } from 'node:path';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { parseCronExpr, parseIntervalExpr, cronMatches } from '../kernel/cronExpr.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { resolveDataDir } from '../kernel/paths.js';
import { appendAudit } from '../store/db.js';
// W3-01：完成终态 → 退出码共享映射（failure 不藏在 exit 0 后面）
import { processExitForCompletion } from '../protocol/completionTransport.js';
// W3-02：wire 入口前端——事件流经纯投影管线，终态走共享 completionTransport（headless，无 React）
import { createWireFrontend } from '../bootstrap/createWireFrontend.js';
// A24 第三类修复：buildInfo system_prompt 数据源（kernel 实时构建；ESM 静态引用缓存）
import { buildSystemPrompt as buildSystemPromptRef } from '../kernel/systemPrompt.js';
import { hasImageIn as hasImageInRef } from '../kernel/providers.js';
import { WXNODUS_VERSION } from '../kernel/version.js';

// 版本单一事实源：package.json（kernel/version.ts 运行时读取——改版本只动 package.json）
const VERSION = WXNODUS_VERSION;
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
const { parseArgs } = await import('./args.js');
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
// DX-01：--data-dir 唯一 parser——优先级 CLI > env（WXNODUS_DATA_DIR）> cwd 默认；
// 结果贯穿 locale 读取、SQLite、logs、MCP、plugins、models/cache、HAR（全部以 dataDir 为根）。
const { parsePreBootstrapArgs, readLocaleFile, promptLanguageOnStdio, persistPreBootstrapLocale } = await import('../application/bootstrap/preBootstrapOnboarding.js');
// R13 bootstrap（KF-003）：首次安装引导唯一入口——CLI 只经 runSetupWizard 决策
const { runSetupWizard } = await import('../bootstrap/setupWizard.js');
const preArgs = parsePreBootstrapArgs(process.argv.slice(2));
const dataDir = (preArgs.ok && preArgs.value.dataDir ? preArgs.value.dataDir : resolveDataDir(process.cwd()));
// DX-01：CLI flag 胜出时经 env 通道全链路传播——kernel 内 resolveDataDir(process.cwd()) 各点
// （agent 权限规则/session 事件/浏览器/离线模型缓存等）统一生效，不留第二条数据目录事实源。
if (preArgs.ok && preArgs.value.dataDir) process.env.WXNODUS_DATA_DIR = dataDir;
const pre = await runSetupWizard({
  argv: process.argv.slice(2),
  env: process.env,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  readWorkspaceLocale: () => readLocaleFile(join(process.cwd(), '.wxnodus', 'config.yaml')),
  readUserLocale: () => readLocaleFile(join(dataDir, 'config.json')),
  promptLanguage: promptLanguageOnStdio,
  persistUserLocale: locale => persistPreBootstrapLocale(join(dataDir, 'config.json'), locale),
});
if (pre.mode === 'error') {
  process.stderr.write(`${pre.output ?? 'CONFIG_SCHEMA_INVALID'}\n`);
  process.exitCode = 2;
} else if (pre.mode === 'print-and-exit') {
  // DX-05：help 文案按系统语言本地化（--lang en --help 无中文；code/key 不本地化）
  if (pre.output === 'version') {
    process.stdout.write(`wxnodus ${VERSION}\n`);
  } else {
    const { translate } = await import('../application/i18n/i18nService.js');
    process.stdout.write(translate(pre.locale ?? 'zh-CN', 'cli.usage'));
  }
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
    // DX-01：dataDir 已在 pre-bootstrap 唯一解析（CLI > env > cwd 默认）——此处不再二次解析
    _initErrorLog(dataDir);
    mkdirSync(dataDir, { recursive: true });

  const [{ createCommandBus }, { GatewayClient }, { createApprovalCache }] = await Promise.all([
    import('../app/CommandBus.js'),
    import('../wxnodus-ui/wxGateway.js'),
    import('../kernel/permissions.js'),
  ]);
  const approvalCache = createApprovalCache();

  // W8-00 第二刀：组合根接管 config/repositories/kernel 全量装配（固定阶段 + 失败只 dispose 已启动资源 +
  // shutdown 幂等）。presentation（gateway/TUI/headless、命令注册、审批桥）经 KernelBridges 注入——
  // gateway/commandBus/approvalCache 声明先于组合根调用、装配后赋值（桥闭包调用时才求值，同旧 gateway 模式）。
  let gateway: any = null;
  let commandBus: any = null;

  const { createCliComposition } = await import('../bootstrap/cliComposition.js');
  const composition = await createCliComposition({
    dataDir,
    workspaceRoot: cwd,
    mcpStrict: opts.strictMcpConfig === true,
    bridges: {
      // 非 agent:* 工具的审批 overlay（agent:* 在组合根内经审批桥消费，不二次弹窗）
      approver: async (request) => {
        if (!gateway) return false;
        const choice = await gateway.requestApproval(String(request.toolId), {
          ...(request.args as Record<string, unknown> ?? {}), _effectKind: request.effect.kind,
          // W7-02：system-touch 等决策理由透出到确认弹窗（分类 + 理由展示）
          ...(request.reasonCode ? { _reasonCode: request.reasonCode } : {}),
          ...(Array.isArray(request.obligations) && request.obligations.length ? { _obligations: request.obligations } : {}),
        });
        return choice !== 'deny';
      },
      // 会话级批准缓存（Kimi auto_approve_actions 同款）：「Allow this session」记入缓存，
      // 本次进程内同 action 自动放行不再弹——危险确认不再频繁
      onApproval: async (name, args) => {
        if (approvalCache.has(name, args)) return true;
        if (!gateway) return false;
        const choice = await gateway.requestApproval(name, args);
        if (choice === 'session') approvalCache.grant(name, args);
        return choice !== 'deny';
      },
      onClarify: async (question, choices) => (gateway ? gateway.requestClarify(question, choices) : ''),
      onSecretRequest: async (kind, prompt, name) => (gateway ? gateway.requestSecretInput(kind, prompt, name) : null),
      onFormRequest: async (fields, prompt) => (gateway ? gateway.requestCredentialForm(fields, prompt) : null),
      onCommand: async (input) => {
        const r = await commandBus.execute(String(input));
        return r.output || r.dispatch?.message || r.error || (r.ok ? '' : `命令执行失败：${r.error ?? ''}`);
      },
    },
  });
  if (!composition.ok) {
    console.error(`wxnodus: ${composition.error.code} ${JSON.stringify(composition.error.details ?? {})}`);
    process.exit(2);
  }
  const { config, db, codeIndex, memoryRepository, mem, bus, toolExecution, agent, plugins, reloadMcp, secrets, getMcpClients } = composition.value;
  // W2-03：统一幂等关闭——全部 disposer 尝试、聚合失败 id（bootstrapShutdown 语义）；
  // serve/keepalive/TUI/SIGINT/SIGTERM 共用同一条关闭路径（组合根资源 + CLI 层资源一并聚合）。
  const { createShutdown } = await import('../bootstrap/bootstrapShutdown.js');
  const disposers: Array<{ id: string; dispose: (reason: string) => Promise<void> | void }> = [];
  const shutdown = (reason = 'cli') => createShutdown([
    ...disposers,
    { id: 'composition', dispose: () => composition.value.shutdown(reason).then(ids => { if (ids.length) throw new Error(`composition failed: ${ids.join(',')}`); }) },
  ])(reason);
  // W3 Memory 影子双写（决策：影子双写、观察后切换）：legacy 消息写入是唯一行为事实源，
  // 影子同步写 modern 显式记忆记录（session scope，失败只计数不上抛）；召回观察期保持 legacy。
  // mem/memoryRepository 已由组合根装配（同一实例供影子写与 /memory 命令 memoryServiceFor 共用）。
  const { createMemoryService } = await import('../application/memoryService.js');
  const settings = config.get('settings') as { apiKeyEnc?: string; model?: string; baseURL?: string; mode?: string; theme?: string; thinking?: boolean; workspace?: string };
  // 档案迁移：旧 apiKeyEnc/baseURL/model → providers[0]（备份原 settings.json）
  const { migrateLegacyProviderSettings } = await import('../kernel/profiles.js');
  migrateLegacyProviderSettings(config);
  // W7-00：主工作区动态指定（用户动态确定的项目文件夹）——cli(--workspace) > env(WXNODUS_WORKSPACE) >
  // persisted(settings.workspace) > cwd 默认；显式非法 fail-closed 绝不静默降级。
  // 文件操作/下载落盘/同化索引统一以 workspaceRoot 为边界根。
  const { resolveWorkspaceRoot } = await import('../domain/config/workspaceRoot.js');
  const resolvedWorkspace = resolveWorkspaceRoot({
    cli: opts.workspace ?? undefined,
    env: process.env.WXNODUS_WORKSPACE,
    persisted: settings.workspace,
    cwd,
  });
  if (!resolvedWorkspace.ok) {
    console.error(`wxnodus: ${resolvedWorkspace.error.code} ${JSON.stringify(resolvedWorkspace.error.details ?? {})}`);
    process.exit(2);
  }
  const workspaceRoot = resolvedWorkspace.value.value;
  const workspaceSource = resolvedWorkspace.value.source;
  // 默认模型/端点兜底：/model set-key 只保存密钥时，若 config 无 model/baseURL，
  // agent 的 defaultCallModel 会因 `!s.model || !s.baseURL` 走「未配置密钥」引导
  // （提示「未配置」）——有 key 即视为已配置，补齐默认值并持久化。
  // 同时校验 model 必须是合法 modelId：遗留数据可能把 UI 命令串
  // （"deepseek-reasoner --provider deepseek"）写进 model 字段，
  // 会导致 API 请求模型名非法而失败。
  if (settings.apiKeyEnc) {
    // 根因修复：只补空值，不再把 catalog 外模型名强制回退默认（档案/中转站自定义名可用）
    if (!settings.model || !String(settings.model).trim()) {
      settings.model = resolveDefaultModel({});
      config.setKey('settings', 'model', settings.model);
    }
    if (!settings.baseURL) {
      settings.baseURL = resolveDefaultBaseURL({});
      config.setKey('settings', 'baseURL', settings.baseURL);
    }
  }
  let model = settings.model ?? (settings.apiKeyEnc ? resolveDefaultModel({}) : '');

  // W3 MCP facade：incoming server 共享构造（--mcp-server stdio 与 --serve /mcp Streamable HTTP 同一 ports）——
  // CapabilityPort 用真实 registry（require 决定 surface）；pipeline 为生产 ToolExecutionPipeline
  // （delivered surface 真实执行；未接线 surface 仍 NOT_DELIVERED fail-closed，绝不假发布）
  const { createHash, randomUUID } = await import('node:crypto');
  const { Wave1CapabilityRegistry } = await import('../application/capabilities/capabilityRegistry.js');
  const { createMcpIncomingServer } = await import('../application/mcp/mcpServerWiring.js');
  const policySnapshotId = createHash('sha256').update(JSON.stringify(settings ?? {})).digest('hex');
  const makeMcpIncoming = () => createMcpIncomingServer({
    capabilities: new Wave1CapabilityRegistry(policySnapshotId, () => new Date().toISOString()),
    contextFactory: () => ({
      actorId: 'actor:cli', sessionId: opts.session ?? 'default', runId: null,
      correlationId: randomUUID(), policySnapshotId, locale: 'zh-CN', source: 'cli' as const,
      capabilities: ['memory'], timestamp: new Date().toISOString(),
    }),
    pipeline: toolExecution.pipeline,
  });

  // W3 MCP facade：--mcp-server —— incoming stdio 服务器模式（真实 connect；close 纳入统一 shutdown）
  if (opts.mcpServer) {
    const mcp = makeMcpIncoming();
    disposers.push({ id: 'mcp-incoming', dispose: () => mcp.close() });
    try {
      await mcp.startStdio();
    } catch (e: any) {
      process.stderr.write(`wxnodus: ${String(e?.code === 'MCP_REQUEST_STATE_KEY_MISSING' ? e.message : e?.message ?? e)}\n`);
      process.exitCode = 2;
      await shutdown('mcp-server-start-failed');
      return;
    }
    // 常驻等待（事件循环由 stdio transport 保持）；stdin EOF/transport close 触发 close → shutdown
    process.on('SIGINT', () => { void shutdown('sigint').finally(() => process.exit(0)); });
    process.on('SIGTERM', () => { void shutdown('sigterm').finally(() => process.exit(0)); });
    await new Promise<void>(() => {});
    return;
  }


  // W2-03：--prompt --wire 真实 headless 网关——此前 gateway 恒为 null（TUI 才装配），
  // wire 双向化（stdin 帧 → RPC）与 wire 终态比对静默失效。headless 网关无 React/Ink 依赖，
  // approval/clarify/sudo/secret/form responder 等待 stdin 帧，超时 fail-closed（deny/''/null）。
  if (opts.wire && opts.prompt && !opts.serve) {
    const { createHeadlessWireGateway } = await import('./headlessGateway.js');
    // supremacy 2.1：pending 请求（审批/澄清/密码/表单）经 onRequest 广播进 wire 事件流——
    // 外部前端（IDE 插件/桌面端）凭 request_id 回 approval.respond/clarify.respond 等帧
    gateway = createHeadlessWireGateway({
      sessionId: opts.session ?? 'default',
      onRequest: (ev) => console.log(JSON.stringify({ type: ev.type, ...(Object.fromEntries(Object.entries(ev).filter(([k]) => k !== 'type'))) })),
    });
  }
  // 模式/主题状态
  let mode = (config.get('settings') as any).mode ?? 'smart';
  let themeName = (config.get('settings') as any).theme ?? 'wxnodus';
  let exitRequested = false;

  // 装配并行化（启动就绪路径去串行化）：组合根之后的子系统互不依赖——一次 Promise.all 完成
  // import（taskRunner/term/plugins/handlers/sessionStart/download/ssrf）；创建与注册顺序语义不变
  const [{ createTaskRunner }, { createTerminalManager }, { registerPluginCommands, registerPluginNlTriggers },
    { registerCoreHandlers }, { registerExtHandlers },
    { createSessionStartService }, { SessionStartGenerator }, { BUILTIN_VERIFIER_DESCRIPTORS }, { hooksFromConfig },
    { downloadFile, writeDownloadEvidence }, { checkUrlSafety }, { Readable }] = await Promise.all([
    import('../kernel/taskRunner.js'),
    import('../kernel/term.js'),
    import('../kernel/plugins.js'),
    import('../commands/handlers.js'),
    import('../commands/handlersExt.js'),
    import('../application/sessions/sessionStartService.js'),
    import('../application/sessions/sessionStartGenerator.js'),
    import('../domain/quality/verifier.js'),
    import('../kernel/hooks.js'),
    import('../application/download/downloadService.js'),
    import('../kernel/ssrf.js'),
    import('node:stream'),
  ]);

  // 并行任务系统（/jobs）：shell 真进程 / agent 子代理 / 并行双线子任务——
  // 与主对话并行（三任务并行：主线 + 双支线）；启动恢复遗留孤儿任务
  const taskRunner = createTaskRunner({
    db, bus, dataDir,
    spawnSubagent: (goal) => agent.spawnSubagent(goal),
    maxConcurrent: (settings as any).jobsConcurrency ?? 2,
  });
  taskRunner.recoverOrphans();

  // A20：后台终端（/term）——node-pty 真实交互会话（与 /jobs 一次性执行互补）
  const term = createTerminalManager({ dataDir, cwd });

  // 命令注册
  commandBus = createCommandBus();
  // 插件命令注册为 /<插件名>.<命令名>（如 /example.hello），防与内置命令冲突；
  // 同时动态注册进 SLASH 命令表——routeInput 白名单校验与 UI 补全才能识别。
  // 开放兼容：注册逻辑在 plugins.ts（registerPluginCommands），/plugin reload 复用（热更新）
  registerPluginCommands(commandBus, plugins);
  registerPluginNlTriggers(plugins);

  // 模型热切换：agent 持有 settings 对象引用——改内存字段即生效，再持久化
  const applyModel = (modelId: string, baseURL?: string) => {
    settings.model = modelId;
    if (baseURL) settings.baseURL = baseURL;
    config.setKey('settings', 'model', modelId);
    if (baseURL) config.setKey('settings', 'baseURL', baseURL);
    model = modelId;
  };
  // W3 Session 第 3 步：会话启动工件服务（能力/hook 快照 + sha256 绑定 + 原子持久化）——
  // /new 等会话创建点调用 ensure；能力清单取自内置 verifier 所需能力并集（真实快照来源）
  const sessionStartService = createSessionStartService({
    generator: new SessionStartGenerator({
      locale: () => (locale === 'zh-CN' ? 'zh-CN' : 'en'),
      model: () => model || settings.model || 'unconfigured', // 无 key 时占位——工件 model 字段不得为空（validate 拒绝）
      dataDir: () => dataDir,
      hooks: () => {
        const cfg = hooksFromConfig(settings);
        return cfg.sessionStart
          ? [{ id: 'settings.hooks.sessionStart', kind: 'on-session-start' as const, enabled: true }]
          : [];
      },
      capabilities: () => [...new Set(Object.values(BUILTIN_VERIFIER_DESCRIPTORS).flatMap(d => d.requiredCapabilities))].sort(),
      now: () => new Date().toISOString(),
    }),
    fileFor: sid => join(dataDir, 'sessions', sid, 'session-start.json'),
  });

  // W7-00：命令层主工作区动态切换（/workspace set 即时生效；工具管线边界随下次启动）
  let liveWorkspaceRoot = workspaceRoot;
  let liveWorkspaceSource: string = workspaceSource;

  // W7-01：下载框架生产端口——SSRF 逐跳授权（checkUrlSafety）+ undici 流式（无自动重定向）
  // + 证据原子落盘；destDir 边界由 service 经 pathBoundary 以 workspaceRoot 校验。
  const makeHandlerCtx = () => ({
    dataDir, cwd, db, mem, config, bus, commandBus,
    agent,
    // W7-00：主工作区（动态指定）——文件操作/下载/同化边界根 + 来源
    get workspaceRoot() { return liveWorkspaceRoot; },
    get workspaceSource() { return liveWorkspaceSource; },
    setWorkspace: (dir: string | null) => {
      config.setKey('settings', 'workspace', dir);
      liveWorkspaceRoot = dir ?? cwd;
      liveWorkspaceSource = dir ? 'persisted' : 'cwd';
    },
    // W7-01：下载服务（destDir 固定主工作区 downloads/——文件名 sanitize 在 service 内）
    download: async (url: string, destDir: string, fileName?: string) =>
      downloadFile({ url, workspaceRoot: liveWorkspaceRoot, destDir, fileName }, {
        authorizeUrl: checkUrlSafety,
        fetchOnce: async (target) => {
          const { fetch } = await import('undici');
          const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
          return {
            status: res.status,
            headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k, String(v)])),
            body: Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
          };
        },
        evidence: (bundle) => { try { writeDownloadEvidence(dataDir, bundle); } catch { /* 证据失败不阻断下载主链路 */ } },
      }),
    sessionStart: sessionStartService,
    // W7-03：黑洞同化索引（/assimilate --code/--plugins/--mcp 写入；/hole --code 检索）
    codeIndex,
    // W3 Memory：/memory 命令经 session-scoped modern 权威服务（scope 只来自当前会话）
    memoryServiceFor: (sid: string) => createMemoryService(memoryRepository, { sessionId: sid }),
    // W1-08：plugin broker 能力请求的真实执行入口（未装配组合根时 handlersExt 保持 fail-closed）
    toolPipeline: toolExecution.pipeline,
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

  // stdin 管道模式（crush/gemini 对齐：cat 文件 | wxnodus——场景矩阵「stdin 管道 ✗」关闭）：
  // 非 --wire/--serve/--mcp-server 且 stdin 非 TTY 时探测管道输入——有数据则作为一次性输入
  // （-p 存在时 -p 为指令、stdin 为素材；-p 缺失时 stdin 即提问）。--wire 的 stdin 是 RPC
  // 帧通道、--serve 不消费 stdin、--mcp-server 的 stdin 是 MCP stdio 传输——三者绝不混用。
  if (!opts.wire && !opts.serve && !opts.mcpServer && !process.stdin.isTTY) {
    const { readStdinAll, composePipePrompt } = await import('./stdinPipe.js');
    const piped = await readStdinAll();
    if (piped.trim()) opts.prompt = composePipePrompt(opts.prompt, piped);
  }

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
    // W3 MCP facade：incoming Streamable HTTP（/mcp）与 serve 共用生命周期——close 纳入统一 shutdown
    const mcpIncoming = makeMcpIncoming();
    const srv = startServeServer({
      dataDir, cwd, db, bus, mem, agent,
      commandBus,
      config,
      mcpHandler: (req, res) => mcpIncoming.httpHandler(req, res),
    }, port);
    disposers.push({ id: 'serve', dispose: async () => { await srv.close(); } });
    disposers.push({ id: 'mcp-incoming', dispose: () => mcpIncoming.close() });
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
      // KF-027 修复：wire stdin 处理器必须在 gateway ready 之后才接受 RPC 帧——
      // ready 之前到达的帧返回 WIRE_GATEWAY_NOT_READY（不静默吞掉、不提前分发）。
      let wireReady = false;
      if (gateway) {
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const frame = (() => { try { return JSON.parse(line); } catch { return null; } })();
          if (!frame?.method || typeof frame.method !== 'string') return;
          if (!wireReady) {
            console.log(JSON.stringify({ type: 'wire.response', method: frame.method, ok: false, error: { code: 'WIRE_GATEWAY_NOT_READY' } }));
            return;
          }
          const params = (frame.params ?? {}) as Record<string, unknown>;
          void gateway.request(frame.method, params).then((r: any) => {
            if (r && typeof r === 'object') console.log(JSON.stringify({ type: 'wire.response', method: frame.method, ...r }));
          }).catch(() => {});
        });
      }
      // W3-02：wire 入口前端——gateway 事件流经纯投影管线，终态上报与共享表比对（漂移即 FRONTEND_COMPLETION_MISMATCH）
      const frontend = gateway ? createWireFrontend(gateway) : null;
      wireReady = true; // gateway + 前端 + 事件订阅全部装配完成——此时才接受 RPC 帧
      const result = await agent.run(text);
      // KF-023/024：agent 完成态细分优先于 ok 布尔（incomplete → exit 3，走共享 completionTransport）
      const wireStatus = result.interrupted ? 'cancelled' as const : result.status ?? (result.ok ? 'succeeded' as const : 'failed' as const);
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
        // @提及展开（与 TUI 同链路）：存在的 @path 读入内容块；不存在的原文保留
        let finalText = text;
        try {
          const { expandMentions } = await import('../kernel/mentions.js');
          const r = expandMentions(finalText, {
            cwd: process.cwd(),
            readFile: p => { try { return readFileSync(p); } catch { return null; } },
          });
          finalText = r.text;
          for (const m of r.missing) process.stderr.write(`wxnodus: 提及文件不存在（原文保留）：${m}\n`);
          for (const m of r.skipped) process.stderr.write(`wxnodus: 提及文件为二进制已跳过：${m}\n`);
        } catch { /* 展开失败按原文提交 */ }
        const result = await agent.run(finalText);
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

  // W8-20/21：终端能力层级引导（cmd/conhost 风险防线）——conhost 候选走 PS 开 VT + CPR 探测；
  // VT 不可用 → 诚实指引退出（绝不输出乱码 TUI）。结果缓存在模块级供渲染器能力注入（W8-22）。
  const { bootstrapConsoleForTui, noVtGuidance } = await import('../wxnodus-ui/lib/consoleBootstrap.js');
  const { setTuiTerminalTier } = await import('../wxnodus-ui/lib/terminalTier.js');
  const consoleEnv = await bootstrapConsoleForTui(process.env);
  if (consoleEnv.tier === 'no-vt') {
    consoleEnv.restore();
    process.stderr.write(`${noVtGuidance(consoleEnv.reason)}\n`);
    void shutdown('no-vt-console').finally(() => process.exit(2));
    return;
  }
  setTuiTerminalTier(consoleEnv);

  try { process.stdout.write('\x1b]0;WxNodus\x07'); } catch {}

  // 简化人工操作（阶段 C）：启动自动恢复上次未完成会话（settings.autoResume=false 关闭）
  if ((settings as any).autoResume !== false) {
    const { pickResumeSession } = await import('../store/db.js');
    const resumeId = pickResumeSession(db);
    if (resumeId) {
      agent.setSessionId(resumeId);
      // KF-028：绑定恢复的会话——后续 Gateway/UI 一律经 agent.getSessionId() 读取，
      // 绝不回落 'default'（恢复后仍指向默认会话 = 假恢复）
      const boundSessionId = agent.getSessionId() ?? resumeId;
      bus.emit('system.notice', { text: `已自动恢复上次未完成会话 ${boundSessionId.slice(0, 8)}…（/new 可开始新会话）` });
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

  // W3 TUI 第 1 步：组合路由决策——modern/required 在 WxGatewayKernel 收缩完成前 fail-closed
  {
    const { decideTuiRoute } = await import('../bootstrap/tuiRouting.js');
    const tuiRoute = decideTuiRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!tuiRoute.ok) {
      console.error(`wxnodus: ${tuiRoute.error.message}`);
      void shutdown('tui-route-denied').finally(() => process.exit(2));
      return;
    }
  }

  // WxNodus UI 装配
  // W3 TUI facade：presentation adapter——db/agent/memory 原始句柄留在组合根，UI 只经窄端口；
  // ensureSession 接真实 session 生命周期（sessionStartService.ensure——工件先行，失败 fail-closed）
  const { createTuiPresentationAdapter } = await import('../presentation/tui/tuiPresentationAdapter.js');
  gateway = new GatewayClient({
    bus, config, commandBus,
    adapter: createTuiPresentationAdapter({
      db, agent,
      settings,
      ensureSession: async (sid) => {
        const r = await sessionStartService.ensure(sid);
        return r.ok ? { ok: true as const } : { ok: false as const, code: r.error.code };
      },
    }),
    dataDir, cwd, settings, reloadMcp, updateBehind,
    // 审计回调（组合根注入——gateway 不直接访问 db；model.add/save_key 落审计）
    audit: (event, payload) => {
      try { appendAudit(db, event, payload); } catch { /* 审计表未就绪静默 */ }
    },
    // A24 第三类修复：MCP 服务器真实状态（连接/工具数/传输方式）——buildInfo 填充 mcp_servers
    mcpStatus: () => getMcpClients().map(c => ({
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
          // KF-004：settings.personality 真实消费——persona 段进入系统提示
          persona: (settings as any).personality,
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
    // W8-22：终端层级能力注入渲染器（cmd 档门控序列/颜色；modern 档 = 现状零变化）
    const { rendererCapabilitiesFor } = await import('../wxnodus-ui/lib/terminalTier.js');
    app = render(React.createElement(App, { gw: gateway }), { exitOnCtrlC: false, capabilities: rendererCapabilitiesFor(consoleEnv) })
  } catch (e: any) {
    if (process.env.WXNODUS_DEBUG_EVENTS) process.stdout.write('[boot] render FAILED: ' + String(e?.message ?? e).slice(0, 200) + '\n')
    throw e
  }

  // Ctrl+C：运行中中断 / 空闲退出
  // B1/W2-03 统一退出清理：MCP 子进程 + DB + UI 全部回收（SIGINT/SIGTERM/requestExit 共用
  // main 顶部定义的共享幂等 shutdown——聚合全部 disposer 失败，不再各分支手写 process.exit）
  disposers.push({ id: 'ui', dispose: () => { app?.unmount(); } });
  // W8-21：退出时 best-effort 恢复 conhost 输入模式（QuickEdit/行/回显）
  disposers.push({ id: 'console-restore', dispose: () => { consoleEnv.restore(); } });

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
