#!/usr/bin/env node
// src/cli/index.ts — L6-2 CLI 入口（commander + WxNodus UI 装配）
// 装配：data/config/db/mem/bus/agent → wxGateway（进程内桥接）→ @wxnodus/ink render App

import { join, dirname, resolve } from 'node:path';
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { format } from 'node:util';
import { parseCronExpr, parseIntervalExpr, cronMatches } from '../kernel/cronExpr.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { resolveDataDir } from '../kernel/paths.js';
import { appendAudit } from '../store/db.js';
import { isSharedAgentReentrantCommand } from '../application/runs/internalCommandGuard.js';
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
const isAcpServerPrompt = /^\/acp\s+server\s*$/i.test(String(opts.prompt ?? '').trim());
if (isAcpServerPrompt) {
  console.log = (...args: unknown[]) => {
    process.stderr.write(`${format(...args)}\n`);
  };
}
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
  let emergencyShutdown: ((reason: string) => Promise<string[]>) | undefined;
  // 首次安装语言选择完成 → 以所选语言欢迎 + 四步清单（选择结果即时可见；后续启动不再提示）
  if (pre.mode === 'onboarding-required' && !isAcpServerPrompt) {
    const { translate } = await import('../application/i18n/i18nService.js');
    process.stdout.write(`${translate(locale, 'onboarding.welcome')}\n`);
    const { probeOutbound, firstRunChecklistLines } = await import('../commands/updateCheck.js');
    const net = await probeOutbound('https://api.github.com');
    for (const line of firstRunChecklistLines(locale, net, translate)) process.stdout.write(`${line}\n`);
  }

  async function main() {
    const startupCwd = process.cwd();
    // DX-01：dataDir 已在 pre-bootstrap 唯一解析（CLI > env > cwd 默认）——此处不再二次解析
    _initErrorLog(dataDir);
    mkdirSync(dataDir, { recursive: true });

    // W7-00：任何 DB/MCP/plugin/Agent 副作用前先读取配置并确定唯一工作区根。
    // cli(--workspace) > env > persisted > --cwd/启动目录；显式非法值 fail-closed。
    const { createConfig } = await import('../store/config.js');
    const config = createConfig(dataDir);
    const { migrateLegacyProviderSettings } = await import('../kernel/profiles.js');
    migrateLegacyProviderSettings(config);
    const settings = config.get('settings') as {
      apiKeyEnc?: string; model?: string; baseURL?: string; mode?: string; theme?: string;
      thinking?: boolean; workspace?: string; [key: string]: any;
    };
    const { resolveWorkspaceRoot } = await import('../domain/config/workspaceRoot.js');
    // V4 P4-3：wxnodus doctor [local] —— 全链路自诊断子命令（codex doctor 机制对齐）。
    // 结构化报告 + exit code 可判（0=无故障/1=存在故障）；local 跳过网络项；--json 机读。
    // positional 用 indexOf 定位而非 [0]：--data-dir 等带值旗标的值会被宽松解析器收进
    // positional 前部（doctor 未必是首元——与既有宽松解析语义一致）。
    const doctorIdx = opts.positional.indexOf('doctor');
    // V4 P5-1：wxnodus update 自升级子命令（用户权力——绝不自动安装）
    //   update [--check]：查 feed 报告（默认即 check，安装需显式 --apply）
    //   update --apply：下载→sha256→备份→安装→验证（失败自动恢复旧版）
    //   update --file <zip>：气隙/私有部署本地包安装（同 apply 链路）
    //   update --skip <ver>：跳过该版本（不再提示）/ update --rollback：回退上一版
    const updateIdx = opts.positional.indexOf('update');
    if (updateIdx >= 0) {
      const subArgs = opts.positional.slice(updateIdx + 1).filter(a => a !== '--check');
      const { fetchLatestRelease, markVersionSkipped, loadUpdateState, applyUpdate, rollbackUpdate } = await import('../kernel/selfUpdate.js');
      const feed = (settings.updateFeed as string) || process.env.WXNODUS_UPDATE_FEED || null;
      const currentVersion = WXNODUS_VERSION;

      if (subArgs[0] === '--skip') {
        const ver = subArgs[1];
        if (!ver) { process.stderr.write('用法：wxnodus update --skip <版本号>\n'); process.exit(2); }
        markVersionSkipped(dataDir, ver);
        process.stdout.write(`已跳过 ${ver}（该版本不再提示新版本可用）\n`);
        process.exit(0);
      }
      // 安装目录上探（zip 渠道：install-meta.json 所在目录；找不到 null）
      const findInstallTarget = (): string | null => {
        let d = dirname(import.meta.url);
        for (let i = 0; i < 5; i++) {
          if (existsSync(join(d, 'install-meta.json'))) return d;
          const p = dirname(d);
          if (p === d) break;
          d = p;
        }
        return null;
      };
      if (subArgs[0] === '--rollback') {
        const targetDir = findInstallTarget();
        if (!targetDir) { process.stdout.write('仅离线 zip 安装渠道支持 --rollback（git/npm 渠道用各自包管理器回退）\n'); process.exit(1); }
        const r = await rollbackUpdate(targetDir);
        process.stdout.write([...r.steps, ...(r.ok ? [] : [r.error!])].join('\n') + '\n');
        process.exit(r.ok ? 0 : 1);
      }
      if (subArgs[0] === '--apply' || subArgs[0] === '--file') {
        // 安装链：--file <zip> 本地字节；--apply 从 feed 下载（须有 sha256 或明确无校验提示）
        let zipBuffer: Buffer;
        let expectedSha256: string | null = null;
        try {
          if (subArgs[0] === '--file') {
            const p = subArgs[1];
            if (!p || !existsSync(resolve(startupCwd, p))) { process.stderr.write(`本地包不存在：${p}\n`); process.exit(2); }
            zipBuffer = readFileSync(resolve(startupCwd, p));
          } else {
            const info = await fetchLatestRelease(feed, currentVersion);
            if (!info.updateAvailable || !info.downloadUrl) {
              process.stdout.write(`无可升级版本（${info.notes ?? `当前 ${currentVersion} 已是最新`}）\n`);
              process.exit(0);
            }
            process.stdout.write(`下载 ${info.downloadUrl} …\n`);
            const res = await fetch(info.downloadUrl, { signal: AbortSignal.timeout(300_000) });
            if (!res.ok) { process.stderr.write(`下载失败：HTTP ${res.status}\n`); process.exit(1); }
            zipBuffer = Buffer.from(await res.arrayBuffer());
            expectedSha256 = info.sha256;
            if (!expectedSha256) process.stdout.write('⚠ feed 未提供 sha256——将跳过完整性校验（私有通道文件请自行核对）\n');
          }
          const targetDir = findInstallTarget();
          if (!targetDir) { process.stdout.write('当前运行产物不在 zip 安装目录内（install-meta.json 未找到）——--apply/--file 仅支持离线 zip 渠道；git/npm 渠道请用 /update 指引的包管理器命令\n'); process.exit(1); }
          const r = await applyUpdate({
            zipBuffer,
            expectedSha256,
            targetDir,
            extract: async (buf, dest) => {
              const { readZip } = await import('../application/release/zipArchive.js');
              const parsed = readZip(buf);
              if (!parsed.ok) throw new Error(`zip 解析失败：${parsed.error.code}`);
              for (const [path, content] of parsed.value) {
                const out = join(dest, path);
                mkdirSync(dirname(out), { recursive: true });
                writeFileSync(out, content);
              }
            },
            runInstaller: async (zipDir, target) => {
              const { execFile } = await import('node:child_process');
              const { promisify } = await import('node:util');
              const execFileAsync = promisify(execFile);
              try {
                const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(zipDir, 'install.ps1'), '-TargetDir', target], { windowsHide: true, timeout: 300_000 });
                return { ok: true, output: String(stdout) };
              } catch (e: any) { return { ok: false, output: String(e?.message ?? e) }; }
            },
            verifyInstalled: async (target) => {
              try {
                const { execFile } = await import('node:child_process');
                const { promisify } = await import('node:util');
                const { stdout } = await promisify(execFile)(process.execPath, [join(target, 'cli', 'index.js'), '--version'], { windowsHide: true, timeout: 30_000 });
                const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
                return m ? m[1]! : null;
              } catch { return null; }
            },
          });
          process.stdout.write(r.steps.join('\n') + '\n' + (r.ok ? `\n升级完成——重启 wxnodus 生效（如需回退：wxnodus update --rollback）\n` : `\n${r.error}\n`));
          process.exit(r.ok ? 0 : 1);
        } catch (e: any) {
          process.stderr.write(`更新失败：${String(e?.message ?? e).slice(0, 300)}\n`);
          process.exit(1);
        }
      }
      // 默认/--check：诚实报告（渠道/版本/feed 比对/跳过状态）
      const info = await fetchLatestRelease(feed, currentVersion);
      const state = loadUpdateState(dataDir);
      const skippedNote = info.latest && state.skipped.includes(info.latest) ? `（已 --skip 跳过）` : '';
      process.stdout.write([
        `当前版本：wxnodus ${currentVersion}`,
        `更新源：${feed ?? '未配置（settings.updateFeed 或 WXNODUS_UPDATE_FEED；气隙部署用 update --file <zip>）'}`,
        info.latest ? `远程最新：${info.latest}${skippedNote}` : `远程探测：${info.notes ?? '不可用'}`,
        info.updateAvailable && !skippedNote
          ? `有新版本可用——wxnodus update --apply 升级（绝不自动安装；sha256 校验+失败自动恢复）/ update --skip ${info.latest} 跳过该版本`
          : `已是最新（或已跳过）`,
      ].join('\n') + '\n');
      process.exit(0);
    }
    if (doctorIdx >= 0) {
      const { openDB } = await import('../store/db.js');
      const db = openDB(dataDir);
      const { runDoctor, renderDoctorText } = await import('../kernel/doctor.js');
      const report = await runDoctor({
        dataDir, db, settings,
        cwd: startupCwd,
        modulePath: import.meta.url,
        network: opts.positional[doctorIdx + 1] !== 'local',
      });
      db.close();
      // --json 可出现在子命令命名空间内（doctor local --json——透传后 opts.json 不置位，查 positional）
      if (opts.json || opts.positional.includes('--json')) {
        process.stdout.write(JSON.stringify({ ok: report.exitCode === 0, ...report }, null, 2) + '\n');
      } else {
        process.stdout.write(renderDoctorText(report));
      }
      process.exit(report.exitCode);
    }
    const resolvedWorkspace = resolveWorkspaceRoot({
      cli: opts.workspace ?? undefined,
      env: process.env.WXNODUS_WORKSPACE,
      persisted: settings.workspace,
      cwd: startupCwd,
    });
    if (!resolvedWorkspace.ok) {
      console.error(`wxnodus: ${resolvedWorkspace.error.code} ${JSON.stringify(resolvedWorkspace.error.details ?? {})}`);
      process.exit(2);
    }
    const workspaceRoot = resolvedWorkspace.value.value;
    const workspaceSource = resolvedWorkspace.value.source;
    // 既有 CLI 子系统使用 cwd 命名；其值现在固定为本进程权威规范工作区。
    const cwd = workspaceRoot;

    // 2026-08-19 卡死诊断探针（env 门控，默认关闭）：WXNODUS_HEARTBEAT=1 时每 2s 向
    // dataDir/logs/heartbeat-<日期>.log 写心跳。cmd 冻结（conhost/QuickEdit 类）不产生
    // JS 异常——error-*.log 看不到；心跳断档的时间点即卡死发生点。
    // 配合 scripts/watch-wxnodus.mjs 或 PowerShell Get-Content -Wait 实时观察。
    let heartbeatTimer: NodeJS.Timeout | undefined;
    if (process.env.WXNODUS_HEARTBEAT === '1') {
      const hbFile = () => join(dataDir, 'logs', `heartbeat-${new Date().toISOString().slice(0, 10)}.log`);
      heartbeatTimer = setInterval(() => {
        try { appendFileSync(hbFile(), `${new Date().toISOString()} alive\n`); } catch { /* 落盘失败静默 */ }
      }, 2000);
      heartbeatTimer.unref?.();
    }

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
  // V4 P5-1：启动单次新版本检查——与组合根装配并行（零额外启动延迟；未配 feed 零网络），
  // 结果在 TUI 启动前一行输出（banner 在首帧之前——不与渲染交错）。绝不自动安装。
  const feedUrl = (settings.updateFeed as string) || process.env.WXNODUS_UPDATE_FEED || null;
  const updateBanner = feedUrl
    ? (async () => {
        try {
          const { fetchLatestRelease, loadUpdateState } = await import('../kernel/selfUpdate.js');
          const info = await fetchLatestRelease(feedUrl, WXNODUS_VERSION, fetch, 4000);
          const skipped = info.latest && loadUpdateState(dataDir).skipped.includes(info.latest);
          if (info.updateAvailable && !skipped) {
            return `↻ 新版本 ${info.latest} 可用：wxnodus update --apply 升级（绝不自动安装）· update --skip ${info.latest} 跳过提示`;
          }
        } catch { /* banner 检查失败静默 */ }
        return null;
      })()
    : null;
  const composition = await createCliComposition({
    dataDir,
    config,
    workspaceRoot,
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
      onCommand: async (input, signal) => {
        if (isSharedAgentReentrantCommand(input)) {
          return `命令不能从当前 Agent 工具内重入：${String(input).trim().split(/\s+/, 1)[0]}（请作为顶层命令执行）`;
        }
        const r = await commandBus.execute(String(input), { signal });
        return r.output || r.dispatch?.message || r.error || (r.ok ? '' : `命令执行失败：${r.error ?? ''}`);
      },
      executeCommand: (input, context) => commandBus.execute(String(input), context),
    },
  });
  if (!composition.ok) {
    console.error(`wxnodus: ${composition.error.code} ${JSON.stringify(composition.error.details ?? {})}`);
    process.exit(2);
  }
  const {
    db, codeIndex, memoryRepository, mem, bus, toolExecution, runInvocation, delegateManager, agent,
    getPlugins, bindPluginRegistry, reloadPlugins, reloadMcp, secrets, getMcpClients,
  } = composition.value;
  // W2-03：统一幂等关闭——全部 disposer 尝试、聚合失败 id（bootstrapShutdown 语义）；
  // serve/keepalive/TUI/SIGINT/SIGTERM 共用同一条关闭路径（组合根资源 + CLI 层资源一并聚合）。
  const { createCliShutdown, isLiveDelegateHost } = await import('./lifecycle.js');
  const disposers: Array<{ id: string; dispose: (reason: string) => Promise<void> | void }> = [];
  if (heartbeatTimer) disposers.push({ id: 'heartbeat', dispose: () => { clearInterval(heartbeatTimer); } });
  let shutdownOnce: ((reason: string) => Promise<string[]>) | undefined;
  const shutdown = (reason = 'cli') => {
    shutdownOnce ??= createCliShutdown(composition.value.shutdown, disposers);
    return shutdownOnce(reason);
  };
  emergencyShutdown = shutdown;
  const exitAfterShutdown = async (code: number, reason: string): Promise<never> => {
    const failures = await shutdown(reason);
    process.exit(failures.length ? 1 : code);
  };
  // W3 Memory 影子双写（决策：影子双写、观察后切换）：legacy 消息写入是唯一行为事实源，
  // 影子同步写 modern 显式记忆记录（session scope，失败只计数不上抛）；召回观察期保持 legacy。
  // mem/memoryRepository 已由组合根装配（同一实例供影子写与 /memory 命令 memoryServiceFor 共用）。
  const { createMemoryService } = await import('../application/memoryService.js');
  // settings 在组合前读取；composition 与 CLI 共享同一 Config/稳定快照引用。
  // 档案迁移也已在组合前完成，保证 Agent 首次构建即消费迁移后的值。
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
    capabilities: new Wave1CapabilityRegistry(policySnapshotId, () => new Date().toISOString(),
      ['session', 'build', 'verify', 'evidence'] as const),
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
  const [{ createTaskRunner }, { createTerminalManager },
    { registerCoreHandlers }, { registerExtHandlers },
    { createSessionStartService }, { SessionStartGenerator }, { BUILTIN_VERIFIER_DESCRIPTORS }, { hooksFromConfig },
    { downloadFile, writeDownloadEvidence }, { checkUrlSafety }, { Readable }] = await Promise.all([
    import('../kernel/taskRunner.js'),
    import('../kernel/term.js'),
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
    spawnSubagent: (goal, signal, context) =>
      agent.spawnSubagent(goal, 1, undefined, { signal, context }),
    maxConcurrent: (settings as any).jobsConcurrency ?? 2,
  });
  taskRunner.recoverOrphans();
  disposers.push({ id: 'task-runner', dispose: reason => taskRunner.shutdown(reason) });

  // A20：后台终端（/term）——node-pty 真实交互会话（与 /jobs 一次性执行互补）
  const term = createTerminalManager({ dataDir, cwd });
  disposers.push({
    id: 'terminal-manager',
    dispose: reason => term.shutdown(reason),
  });

  // 命令注册：插件 owner 原子同步命令、NL 与 Agent 工具三张表；失败则关闭已装配资源。
  commandBus = createCommandBus();
  const pluginBinding = await bindPluginRegistry(commandBus);
  if (!pluginBinding.ok) {
    console.error(`wxnodus: ${pluginBinding.message}`);
    await shutdown('plugin-runtime-bind-failed');
    process.exit(2);
  }

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

  // W7-00：当前进程工作区在启动期固定；设置只持久化到下次启动。
  const liveWorkspaceRoot = workspaceRoot;
  const liveWorkspaceSource: string = workspaceSource;

  // W7-01：下载框架生产端口——SSRF 逐跳授权（checkUrlSafety）+ undici 流式（无自动重定向）
  // + 证据原子落盘；destDir 边界由 service 经 pathBoundary 以 workspaceRoot 校验。
  const makeHandlerCtx = () => ({
    dataDir, cwd, db, mem, config, bus, commandBus, runInvocation, delegateManager,
    get liveDelegateHost() {
      return isLiveDelegateHost({
        serve: opts.serve,
        prompt: opts.prompt,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
      });
    },
    registerDisposer: (id: string, dispose: () => Promise<void> | void) => {
      if (disposers.some(entry => entry.id === id)) return;
      disposers.push({ id, dispose });
    },
    agent,
    // W7-00：主工作区（动态指定）——文件操作/下载/同化边界根 + 来源
    get workspaceRoot() { return liveWorkspaceRoot; },
    get workspaceSource() { return liveWorkspaceSource; },
    setWorkspace: (dir: string | null) => {
      config.setKey('settings', 'workspace', dir);
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
    clearHistory: () => {
      // CLI 模式真实清空：当前会话非系统消息全部归档（archive 软清空——同 TUI /clear 语义，不物理删除）
      const sid = agent.getSessionId?.() ?? 'default';
      const ids = (db.prepare(`SELECT id FROM messages WHERE session_id = ? AND role != 'system' AND archived = 0`).all(sid) as Array<{ id: number }>).map(r => r.id);
      if (ids.length) {
        db.prepare(`UPDATE messages SET archived = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      }
    },
    setModel: applyModel,
    openModelPicker: () => { /* WxNodus UI: /model 打开选择器 */ },
    openSessions: () => { /* WxNodus UI: /sessions 打开列表 */ },
    setThinking: (on: boolean) => { config.setKey('settings', 'thinking', on); },
    reloadMcp,
    getPlugins,
    reloadPlugins,
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

  // ACP 是长驻 stdio transport：自身不接纳 Run，每个 prompt 经 runInvocation 独立接纳。
  // 必须在 stdin 管道读取和通用命令分派之前启动，否则协议帧会被当作 prompt 素材，
  // 或 transport 命令占住共享 Agent FIFO 导致后续 prompt 永久排队。
  if (isAcpServerPrompt) {
    const { runAcpServer } = await import('../kernel/acp.js');
    const store = {
      createSession: () => {
        const id = `acp-${randomUUID()}`;
        db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, '', ?, ?)`).run(id, Date.now(), Date.now());
        return id;
      },
      sessionExists: (id: string) => (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id=?`).get(id) as { c: number }).c > 0,
      loadHistory: (id: string) => (db.prepare(`SELECT role, content FROM messages WHERE session_id=? AND archived=0 ORDER BY id`).all(id) as Array<{ role: string; content: string }>)
        .map(row => ({ role: row.role, content: String(row.content) })),
    };
    const code = await runAcpServer({
      store,
      run: (prompt, sessionId) => {
        const handle = runInvocation.invoke({ kind: 'agent', prompt, sessionId });
        return {
          cancel: () => handle.cancel(),
          completion: handle.completion.then(run => ({
            ok: run.status === 'succeeded',
            status: run.status,
            text: run.value?.text ?? '',
            error: run.error,
          })),
        };
      },
    });
    await shutdown('acp-stdio-close');
    process.exitCode = code;
    return;
  }

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
  const curatorTimer = setTimeout(() => {
    import('../kernel/curator.js').then(({ maybeRunCurator }) => {
      maybeRunCurator({ getSettings: () => config.get('settings') as Record<string, any>, mem, dataDir, cwd, bus });
    }).catch(() => { /* 后台审查失败静默 */ });
  }, 5000);
  disposers.push({ id: 'curator-timer', dispose: () => { clearTimeout(curatorTimer); } });

  // P1-4：冷启动预热——后台加载记忆 embedder（transformers.js 首次加载 ~10s）。
  // 首个 /hole、/memory search 或 agent 自动召回不再白等；失败静默（下次调用再加载）。
  // 仅常驻模式预热（-p 单次执行毫秒级退出，预热无意义）。
  if (!opts.prompt && !opts.serve && !opts.wire) {
    const warmupTimer = setTimeout(() => {
      void (async () => {
        try { await mem.recallHybrid('预热', { limit: 1 }); } catch { /* 静默 */ }
      })();
    }, 0);
    disposers.push({ id: 'memory-warmup-timer', dispose: () => { clearTimeout(warmupTimer); } });
  }

  // 定时任务调度（对比轮 6：/cron 真实执行）——每分钟检查到期任务，后台派发 agent 执行
  // 支持标准 5 字段 cron（分 时 日 月 周）与 every Ns/Nm/Nh/Nd 间隔格式（cronExpr.ts 解析）
  const cronTimer = setInterval(() => {
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
  disposers.push({ id: 'cron-timer', dispose: () => { clearInterval(cronTimer); } });

  // P2-3：cron 结果回执——定时任务（tags 含 cron:<id>）完成时系统通知，
  // 用户不再需要主动 /jobs 查询才知道后台定时任务的结果
  const offCronReceipt = bus.on('jobs.complete', (e: any) => {
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
  disposers.push({ id: 'cron-receipts', dispose: offCronReceipt });

  // AI 网关模式（颠覆性改造）：wxnodus --serve —— 本地 HTTP 服务，
  // 多前端共享同一 agent/记忆/权限面（IDE 插件/浏览器/第二个终端等）
  if (opts.serve) {
    const { startServeServer } = await import('./serve.js');
    // A-S1：SDK 模式端口随机（除非显式 --port）；握手模式由 @wxnodus/sdk 拉起（stdout 单行 JSON）
    const sdk = opts.sdk === true;
    const port = sdk && opts.port == null ? 0 : (opts.port ?? Number(process.env.WXNODUS_SERVE_PORT ?? 4789));
    // G-6（2026-08-28）：serve 面审批闭环——赋值组合根 bridges 依赖的 gateway（此前 serve 分支
    // 从未赋值 → 审批恒 fail-closed deny）；pending 请求广播进 /events（gateway.request 事件，
    // 携 sessionId 供所有权过滤）；*.respond 经 responder 中转结算。
    const serveSessionId = agent.getSessionId?.() ?? 'default';
    gateway = (await import('./headlessGateway.js')).createHeadlessWireGateway({
      sessionId: serveSessionId,
      onRequest: ev => { try { bus.emit('gateway.request', { ...ev, sessionId: agent.getSessionId?.() ?? serveSessionId }); } catch { /* 广播失败不阻断 pending */ } },
    });
    // W3 MCP facade：incoming Streamable HTTP（/mcp）与 serve 共用生命周期——close 纳入统一 shutdown
    const mcpIncoming = makeMcpIncoming();
    const srv = startServeServer({
      dataDir, cwd, db, bus, runInvocation, mem, agent,
      commandBus,
      config,
      mcpHandler: (req, res) => mcpIncoming.httpHandler(req, res),
      responder: (method, params) => gateway.request(method, params),
    }, port, sdk ? {
      sdkHandshake: true,
      onSdkHandshake: (info: { port: number; token: string; pid: number; version: string; protocolVersion: number }) => {
        process.stdout.write(JSON.stringify({ 'wxnodus-sdk': 1, ...info }) + '\n');
      },
    } : {});
    disposers.push({ id: 'mcp-incoming', dispose: () => mcpIncoming.close() });
    disposers.push({ id: 'serve', dispose: async () => { await srv.close(); } });
    if (sdk) {
      // SDK 模式：stdout 归握手行独占（父进程解析）；提示走 stderr 不污染协议
      process.stderr.write(`◉ SDK 网关 pid=${process.pid} 端口由握手行回传（Ctrl+C 停止）\n`);
    } else {
      console.log(`◉ WxNodus AI 网关已启动：http://127.0.0.1:${srv.port}`);
      console.log(`  GET  /health/live  存活探针（无认证）｜ GET /health /rpc /events 需 Bearer（WXNODUS_SERVE_TOKEN）`);
      console.log('  Ctrl+C 停止');
    }
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
    // 会话只绑定到本次不可变 RunContext，不在接纳前改写共享 Agent。
    const ephemeralSid = opts.ephemeral ? `ephemeral-${Date.now().toString(36)}` : null;
    const invocationSessionId = ephemeralSid ?? opts.session ?? agent.getSessionId?.() ?? 'default';
    gateway?.bindSession?.(invocationSessionId);
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
      const runId = randomUUID();
      const correlationId = randomUUID();
      const WIRE_EVENTS = new Set(['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'system.notice', 'run.final']);
      const offs: Array<() => void> = [];
      for (const type of WIRE_EVENTS) {
        offs.push(bus.on(type, (e: any) => {
          if (e?.runId !== runId) return;
          const line = {
            type,
            id: e.id,
            runId: e.runId,
            correlationId: e.correlationId,
            sessionId: e.sessionId,
            ...(e?.payload ?? {}),
          };
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
      const handle = runInvocation.invoke({
        kind: 'agent',
        prompt: text,
        runId,
        correlationId,
        sessionId: invocationSessionId,
      });
      const cancelWire = () => handle.cancel();
      process.once('SIGINT', cancelWire);
      process.once('SIGTERM', cancelWire);
      const run = await handle.completion;
      process.removeListener('SIGINT', cancelWire);
      process.removeListener('SIGTERM', cancelWire);
      const result = run.value;
      const wireStatus = run.status;
      const completion = frontend?.complete(wireStatus, { wireFinal: wireStatus });
      console.log(JSON.stringify({
        type: 'agent.result',
        runId: run.context.runId,
        correlationId: run.context.correlationId,
        sessionId: run.context.sessionId,
        status: wireStatus,
        ok: result?.ok ?? false,
        text: result?.text ?? '',
        turns: result?.turns ?? 0,
        interrupted: result?.interrupted ?? wireStatus === 'cancelled',
        wireFinal: completion && !completion.ok ? 'FRONTEND_COMPLETION_MISMATCH' : wireStatus,
      }));
      for (const off of offs) off();
      frontend?.dispose();
      cleanupEphemeral();
      await exitAfterShutdown(processExitForCompletion(completion && !completion.ok ? 'failed' : wireStatus), 'wire-complete');
    }
    const { routeInput } = await import('../commands/intent.js');
    const routed = await routeInput(text);
    if (routed.kind === 'command' && routed.cmd) {
      const command = routed.cmd + (routed.value ? ' ' + routed.value : '');
      const handle = runInvocation.invoke({ kind: 'command', command, sessionId: invocationSessionId });
      const cancelCommand = () => handle.cancel();
      process.once('SIGINT', cancelCommand);
      process.once('SIGTERM', cancelCommand);
      const run = await handle.completion;
      process.removeListener('SIGINT', cancelCommand);
      process.removeListener('SIGTERM', cancelCommand);
      const r = run.value ?? { ok: false, error: run.error ?? `命令以 ${run.status} 结束`, completionStatus: run.status };
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
      // 命令退出码以协调器的六终态为准，不能退化为 ok:boolean。
      cleanupEphemeral();
      await exitAfterShutdown(processExitForCompletion(run.status), 'command-complete');
    } else if (routed.kind === 'tool' && routed.value) {
      console.log(routed.value);
    } else {
      try {
        // @提及展开（与 TUI 同链路）：存在的 @path 读入内容块；不存在的原文保留
        let finalText = text;
        try {
          const { expandMentions } = await import('../kernel/mentions.js');
          const r = expandMentions(finalText, {
            cwd,
            readFile: p => { try { return readFileSync(p); } catch { return null; } },
          });
          finalText = r.text;
          for (const m of r.missing) process.stderr.write(`wxnodus: 提及文件不存在（原文保留）：${m}\n`);
          for (const m of r.skipped) process.stderr.write(`wxnodus: 提及文件为二进制已跳过：${m}\n`);
        } catch { /* 展开失败按原文提交 */ }
        // 2026-08-19 流式输出（对齐 claude -p / gemini -p / codex exec）+ 稳定性加固：
        // 此前 -p 只在 agent.run 结束后一次性 console.log 全文——长任务里用户
        // 看着空屏等分钟级无反馈。现订阅 agent.token 实时写 stdout（--json 除外，
        // JSON 需要完整对象）。[steer] 注入行是内部干预标记，不进 stdout。
        // 加固 ①：win32+TTY 时关闭 QuickEdit（点击窗口即冻结 cmd 的经典根因——
        // TUI 路径已有同款引导，-p 此前漏了）；失败静默（引导是加固不是必需）。
        // 加固 ②：TTY 下超宽单行按终端宽度软换行——模型输出压缩代码等巨长单行
        // 直写 conhost 会卡死；管道输出保持原始字节（脚本零污染）。
        const streamable = !opts.json
        let streamedAny = false
        if (streamable && process.stdout.isTTY === true && process.platform === 'win32') {
          const { runConsoleModeScript, PS_ENABLE } = await import('../wxnodus-ui/lib/consoleBootstrap.js')
          try { runConsoleModeScript(PS_ENABLE, process.env) } catch { /* 静默 */ }
        }
        const streamOut = (() => {
          const isTty = process.stdout.isTTY === true
          const cols = Math.max(60, process.stdout.columns ?? 80)
          let pending = ''
          const emitLine = (line: string) => {
            if (isTty && line.length > cols) {
              for (let i = 0; i < line.length; i += cols) process.stdout.write(line.slice(i, i + cols) + '\n')
            } else {
              process.stdout.write(line + '\n')
            }
          }
          return {
            push(t: string) {
              const text = pending + t
              const lines = text.split('\n')
              pending = lines.pop() ?? ''
              for (const line of lines) emitLine(line)
            },
            finish() {
              if (pending) emitLine(pending)
              pending = ''
            }
          }
        })()
        const headlessRunId = randomUUID()
        const offToken = streamable
          ? bus.on('agent.token', (e: any) => {
              if (e?.runId !== headlessRunId) return
              const t = String(e?.payload?.text ?? '')
              if (!t || t.startsWith('\n[steer]')) return
              streamedAny = true
              streamOut.push(t)
            })
          : null
        const handle = runInvocation.invoke({
          kind: 'agent',
          prompt: finalText,
          runId: headlessRunId,
          sessionId: invocationSessionId,
        })
        const cancelHeadless = () => handle.cancel()
        process.once('SIGINT', cancelHeadless)
        process.once('SIGTERM', cancelHeadless)
        const run = await handle.completion
        process.removeListener('SIGINT', cancelHeadless)
        process.removeListener('SIGTERM', cancelHeadless)
        offToken?.()
        const result = run.value ?? {
          ok: false,
          text: run.error ?? `Run 以 ${run.status} 结束`,
          turns: 0,
          interrupted: run.status === 'cancelled',
          status: run.status,
        }
        // 流式已输出全部正文——只补挂起行收尾（避免与终稿打印重复）
        if (streamedAny) {
          streamOut.finish()
        }
        if (opts.json) {
          // Gemini --output-format json 的 stats 对齐：usage 为会话累计 token
          let usage: number | null = null;
          try {
            // M-1 附带（审计「-p --json usage 会话错位」）：统计查询会话与 run 实际
            // 会话对齐——此前 opts.session ?? 'default'，--ephemeral 或 agent 自派生会话时查错行（恒 0）
            const row = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens),0) t FROM usage_stats WHERE session_id=?`).get(invocationSessionId) as { t: number } | undefined;
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
                await exitAfterShutdown(42, 'output-schema-invalid'); // V4 L0-5：输入类错误 42（gemini 语义对齐）
              }
            } catch (e: any) {
              process.stderr.write(`wxnodus: --output-schema 校验异常：${String(e?.message ?? e).slice(0, 120)}\n`);
              cleanupEphemeral();
              await exitAfterShutdown(42, 'output-schema-error');
            }
          }
          console.log(JSON.stringify({
            runId: run.context.runId,
            correlationId: run.context.correlationId,
            sessionId: run.context.sessionId,
            status: run.status,
            ok: result.ok,
            text: result.text,
            turns: result.turns,
            interrupted: result.interrupted,
            usage,
          }));
        } else if (!streamedAny) {
          // 无流式 token 到达（如纯工具任务/异常回退）——按旧路径打印终稿
          // （经同一输出通道——TTY 同样软换行防长行卡死；管道保持原始字节）
          streamOut.push(result.text)
          streamOut.finish()
        }
        // 六终态由协调器唯一确定；退出层不再从兼容 ok/interrupted 字段重算。
        cleanupEphemeral();
        await exitAfterShutdown(processExitForCompletion(run.status), 'agent-complete');
      } catch (e: any) {
        // P1-2：可重试失败（429/5xx/网络/超时）→ 75（EX_TEMPFAIL），CI 据此重试
        const { exitCodeForError } = await import('../kernel/errors.js');
        process.stderr.write(`wxnodus: ${e?.message ?? e}
`);
        cleanupEphemeral();
        await exitAfterShutdown(exitCodeForError(e), 'headless-error');
      }
    }
    cleanupEphemeral();
    await exitAfterShutdown(0, 'headless-complete');
  }

  if (!process.stdout.isTTY) {
    console.log('wxnodus: 非 TTY 环境，请使用 -p 非交互模式');
    await exitAfterShutdown(0, 'non-tty-without-input');
  }

  // V4 P5-1：新版本 banner（TUI 首帧之前一行输出；组合根期间并行查询的结果）
  if (updateBanner) {
    const banner = await updateBanner;
    if (banner) process.stdout.write(`${banner}\n`);
  }

  // 版本变更提示（升级后首启可见——落 scrollback 永久可查）：dataDir 记上次运行版本，
  // 与当前不一致即提示「已更新 x→y」（此前升级后进 TUI 零版本反馈——用户实测报告）
  {
    const { detectVersionChange } = await import('../kernel/versionChange.js');
    const changed = detectVersionChange(dataDir);
    if (changed) process.stdout.write(`${changed}\n`);
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
    bus, config, commandBus, runInvocation, taskRunner, delegateManager,
    adapter: createTuiPresentationAdapter({
      db, agent,
      settings,
      dataDir,
      ensureSession: async (sid) => {
        const r = await sessionStartService.ensure(sid);
        return r.ok ? { ok: true as const } : { ok: false as const, code: r.error.code };
      },
    }),
    dataDir, cwd, settings, reloadMcp, getPlugins, reloadPlugins, updateBehind,
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

  // V4 P2-11：SIGINT 双语义——第一次仅中断当前 Run（gateway 转发），提示「再按退出」；
  // 第二次（或空闲态单击）才真正退出。此前 300ms 无条件强退：长任务中想中止任务
  // （claude code 标准行为）却整个 CLI 退出，会话中断、后台任务未收尾（与注释宣称矛盾）。
  let firstSigintAt = 0;
  process.on('SIGINT', () => {
    if (exitRequested) { void shutdown('sigint').finally(() => process.exit(0)); return; }
    const now = Date.now();
    const busy = gateway?.running === true;
    if (busy && now - firstSigintAt > 1_500) {
      // 运行中第一次：只中断当前 Run（双 Esc 同族肌肉记忆——中断不退出）
      firstSigintAt = now;
      gateway.kill('SIGINT');
      try { app?.unmount(); } catch { /* UI 已卸载 */ }
      console.log('\n已中断当前任务——再按 Ctrl+C 退出 wxnodus');
      return;
    }
    // 第二次（1.5s 内）或空闲态单击：真正退出
    exitRequested = true;
    void shutdown('sigint').finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => { void shutdown('sigterm').finally(() => process.exit(0)); });
}

main().catch(async e => {
  console.error('启动失败：', e?.message ?? e);
  try { await emergencyShutdown?.('uncaught-main-error'); } catch {}
  process.exit(1);
});
}
