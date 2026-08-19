// src/commands/handlers.ts — L6-2 核心命令处理器（注册到 CommandBus）
// 设计：每个命令访问 kernel 上下文（config/db/mem/agent/bus）；输出字符串经消息流呈现
import type { Config } from '../store/config.js';
import type { Db } from '../store/db.js';
import type { Memory } from '../kernel/memory.js';
import { appendAudit } from '../store/db.js';
import { salienceFlag, salienceFromMultiplier } from './memorySalience.js';
import type { EventBus } from '../kernel/events.js';
import type { CommandBus } from '../app/CommandBus.js';
import { SLASH, COMMAND_CAT, COMMAND_DESC, COMMAND_MERGE, resolveAlias, CORE_COMMANDS } from './registry.js';
import { capabilityBadges, decryptKey, filterModels, maskKey, MODEL_CATALOG, resolveApiKey } from '../kernel/providers.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { parseModelAddArgs, addCustomModel, applyModelKey } from '../kernel/modelRegistry.js';
import { profileHealth } from '../kernel/profiles.js';
import { priceForModel } from '../kernel/cost.js';
import { sessionCost, costText } from '../kernel/costQuery.js';
import { snippet } from '../kernel/truncate.js';
import { WXNODUS_VERSION } from '../kernel/version.js';
import { themePresetNames, themeByName, loadUserThemes } from '../wxnodus-ui/theme.js';
import { hooksFromConfig, HOOK_EVENTS } from '../kernel/hooks.js';
import { instantiate } from '../build/scaffold.js';
import { writeEvidence, fingerprint } from '../build/evidence.js';
import { runGate } from '../build/gate.js';
import { searchMessages } from '../kernel/memory.js';
import { join, isAbsolute } from 'node:path';
import { mkdirSync, existsSync, readdirSync, cpSync, writeFileSync } from 'node:fs';

export interface HandlerCtx {
  dataDir: string;
  cwd: string;
  db: Db;
  mem: Memory;
  config: Config;
  bus: EventBus;
  /** agent 实例（/delegate 派生子代理等）；P0-2：第三参数传自定义 agent 定义 */
  agent?: { run(prompt: string, opts?: { goalLoop?: boolean }): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; spawnSubagent(goal: string, depth?: number, def?: { systemPromptOverride?: string; mode?: string; tools?: string[] }): Promise<{ ok: boolean; output: string; turns: number }>; abort(): void; setMode(m: string): void; getMode(): string; setSessionId(id: string): void; getSessionId?(): string; updateTools?(extra: Record<string, any>): void; setScriptRecorder?(fn: ((name: string, args: Record<string, any>) => void) | null): void; runScript?(steps: any[]): Promise<{ ok: boolean; log: Array<{ kind: string; step: number; text: string; name?: string }> }> };
  getModel: () => string;
  getMode: () => string;
  setMode: (m: string) => void;
  setTheme: (t: string) => void;
  getThemeName: () => string;
  requestExit: () => void;
  clearHistory: () => void;
  setModel: (modelId: string, baseURL?: string) => void;
  openModelPicker: () => void;
  openSessions: () => void;
  setThinking: (on: boolean) => void;
  /** MCP 热重载（/mcp add/remove 后自动接通，无需重启） */
  reloadMcp?: () => Promise<{ ok: boolean; count: number; message: string }>;
  /** 命令总线（/plugin reload 重注册插件命令） */
  commandBus?: CommandBus;
  /** UI 网关（动态内容表 requestCredentialForm 等 UI 交互 RPC）——TUI 装配后可用 */
  gateway?: {
    requestCredentialForm(fields: Array<{ name: string; label?: string; kind: string }>, prompt?: string): Promise<Record<string, string> | null>;
    /** W3 Computer：审批桥（高影响动作授权）——TUI 装配后可用 */
    requestApproval?(name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'>;
  } | null;
  /** 敏感数据内存保险库（/security 关闭通道时同步清空） */
  secrets?: import('../kernel/secrets.js').SecretVault;
  /** 并行任务系统（/jobs：shell 真进程 / agent 子代理 / 并行双线子任务） */
  taskRunner?: import('../kernel/taskRunner.js').TaskRunner;
  /** A20：后台终端（/term：node-pty 真实交互会话） */
  term?: import('../kernel/term.js').TermManager;
  /** W3 Session：会话启动工件服务（/new 等会话创建点调用——只生成一次 + 原子持久化） */
  sessionStart?: {
    ensure(sessionId: string): Promise<import('../protocol/results.js').OperationResult<import('../domain/sessions/sessionStart.js').SessionStartDocument>>;
  };
  /** W3 Memory：session-scoped modern 权威服务（/memory 命令只经此端口读写显式记忆记录） */
  memoryServiceFor?(sessionId: string): import('../application/memoryService.js').MemoryService;
  /** W1-08：生产 ToolExecutionPipeline（plugin broker 能力请求与 MCP surface 的真实执行入口） */
  toolPipeline?: import('../domain/tools/toolExecutionPipeline.js').ToolExecutionPipeline;
  /** W7-00：主工作区（用户动态指定）——当前根、来源、持久化写入（/workspace 命令用） */
  workspaceRoot?: string;
  workspaceSource?: string;
  setWorkspace?: (dir: string | null) => void;
  /** W7-01：下载服务（生产端口：SSRF 逐跳授权 + undici 流式 + 证据落盘；未装配 fail-closed） */
  download?: (url: string, destDir: string, fileName?: string) => Promise<import('../protocol/results.js').OperationResult<import('../application/download/downloadService.js').DownloadResult>>;
  /** W7-03：黑洞同化索引（代码/模块/插件/MCP——/assimilate 写入、/hole --code 检索） */
  codeIndex?: {
    search(query: string, opts?: { limit?: number; sources?: Array<'code' | 'plugin' | 'mcp'> }): Array<{ source: string; path?: string; id?: string; head: string; title: string }>;
    indexChunks(chunks: Array<{ source: 'code'; path: string; chunkIndex: number; head: string; text: string }>): void;
    indexSurfaces(entries: Array<{ source: 'plugin' | 'mcp'; id: string; title: string; body: string }>): void;
  };
}

// 显示宽度（CJK/全角=2 列；ANSI 转义序列不计宽）——面板右边界 │ 对齐的唯一数据源
// （此前 l.length 低估中文宽度，/help 等面板右侧 │ 错位）
const dispWidth = (s: string): number => {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    // 跳过 ANSI CSI 序列（着色码对显示宽度贡献 0）
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      const end = s.indexOf('m', i);
      if (end > i) { i = end; continue; }
    }
    const c = s.codePointAt(i)!;
    if (c > 0xffff) i++; // 代理对只计一次
    w +=
      (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a || (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe19) ||
        (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)))
        ? 2
        : c >= 0x0300 && c <= 0x036f
          ? 0
          : 1;
  }
  return w;
};

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => dispWidth(l)), dispWidth(title)) + 4;
  const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - dispWidth(s)));
  return [
    `┌${'─'.repeat(w)}┐`,
    `│ ${pad(title, w - 2)} │`,
    ...body.map(l => `│ ${pad(l, w - 2)} │`),
    `└${'─'.repeat(w)}┘`
  ].join('\n');
};

// TTY 门控 ANSI 着色（面板级样式）：TUI 交互输出彩色（slash 消息已支持 Ansi 渲染），
// -p 管道/测试环境 stdout 非 TTY → 纯文本（脚本与断言零污染）
export const c = (s: string, code: string): string => (process.stdout.isTTY === true ? `\x1b[${code}m${s}\x1b[0m` : s);

export function registerCoreHandlers(bus: CommandBus, ctx: HandlerCtx): void {
  // 对话
  bus.register('/help', (args) => {
    if (args[0] && args[0] !== 'all') {
      const cmd = resolveAlias('/' + args[0].replace(/^\//, ''));
      const merge = COMMAND_MERGE[cmd];
      // 审查修复：UI 本地命令（/details /copy /voice 等）不在内核注册表——此前返回
      // 误导性「无描述」；改为明确提示 TUI 本地命令
      if (!COMMAND_DESC[cmd] && !SLASH.includes(cmd)) {
        return `${cmd}：TUI 本地命令（麦克风钮/Ctrl+K/? 面板等处可用）——/help 全目录不含 UI 层命令`;
      }
      return `${cmd}：${COMMAND_DESC[cmd] ?? '无描述'}${merge ? `（已并入 ${merge}）` : ''}${!CORE_COMMANDS.has(cmd) && SLASH.includes(cmd) ? '（扩展命令——默认 /help 不列出，/help all 可见）' : ''}`;
    }
    // supremacy 1.6：命令面瘦身——默认渲染主干层（47 条日常驾驶命令），
    // /help all 渲染全目录（扩展层照常可用，零删除）
    const showAll = args[0] === 'all';
    // 100% 重构：分组标题行 + 每命令一行两列（命令名 / 描述）——TTY 门控 ANSI 彩色，
    // TUI 彩色（slash 消息已支持 Ansi 渲染）、-p 管道/测试纯文本
    const catName: Record<string, string> = {
      '◈': '对话', '⚙': '模型', '▤': '记忆', '◆': '构建', '⛨': '安全', '◉': '系统',
      '❖': '视觉', '⚿': '输入', '⛭': '网络', '◍': '协作', '☆': '工具', '⬡': '上下文',
      '⬇': '离线',
    };
    const visible = SLASH.filter(cmd => showAll || CORE_COMMANDS.has(cmd));
    const cats = new Map<string, string[]>();
    for (const cmd of visible) {
      const cat = COMMAND_CAT[cmd] ?? '·';
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(cmd);
    }
    const rows: string[] = [];
    for (const [cat, cmds] of cats) {
      rows.push(`${c(` ${cat} ${catName[cat] ?? cat}`, '1;36')}`);
      for (const cmd of cmds) {
        // A22 指令融合：合并命令标注「（=目标命令）」——同义命令不再重复心智负担
        const merge = COMMAND_MERGE[cmd];
        rows.push(`    ${c(cmd.padEnd(26), '35')}${COMMAND_DESC[cmd] ?? ''}${merge ? c(`（=${merge}）`, '2') : ''}`);
      }
    }
    const extCount = SLASH.length - CORE_COMMANDS.size;
    rows.push('', `${c(' ◈ 提示', '1;33')}：/help <命令> 查看单个命令详情 · /map 生成仓库地图`);
    if (!showAll && extCount > 0) {
      rows.push(`${c(` ◈ 扩展命令 ${extCount} 个（进阶/别名/低频——照常可用）——/help all 查看全部`, '2')}`);
    }
    const title = showAll ? ` 命令（全目录 ${SLASH.length} 个） ` : ` 命令（主干 ${CORE_COMMANDS.size} 个） `;
    return lines(title, rows);
  });

  bus.register('/clear', async () => { ctx.clearHistory(); return '已清空'; });

  // 会话（文本列表；TUI 内由本地 slash 拦截打开选择器——本分支只在无 TUI 时到达，不再假装「打开选择器」）
  bus.register('/sessions', (args) => {
    const rows = ctx.db.prepare(`SELECT s.id, s.title, s.created_at, s.updated_at, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msgs FROM sessions s ORDER BY s.updated_at DESC`).all() as any[];
    if (!rows.length) return '暂无会话';
    const q = args.join(' ').trim().toLowerCase();
    const filtered = q ? rows.filter(r => (String(r.title ?? '') + ' ' + r.id).toLowerCase().includes(q)) : rows;
    if (!filtered.length) return `无匹配会话：${q}`;
    // 非交互模式：文本列表（按最近更新排序）——含每会话成本估算（全部模型有定价才显示）
    const costOverrides = (ctx.config.get('settings') as Record<string, any>)?.costPrices;
    const costOf = (id: string): string => {
      const q = sessionCost(ctx.db, id, costOverrides);
      return q && q.unknown === 0 ? `  $${q.usd.toFixed(4)}` : '';
    };
    return lines(' 会话 ', filtered.map(r => {
      const t = new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false });
      return ` ${c(r.id, '35')}  ${r.title || '(无标题)'}（${r.msgs} 条）${costOf(r.id)} ${t}`;
    }));
  });

  bus.register('/quit', async () => { ctx.requestExit(); return '再见'; });

  // /voice：语音模式（审查修复：此前仅 TUI 本地命令、/help 查不到、-p 报未知命令——
  // 现注册进命令面；TUI 内由麦克风钮/Ctrl+B 走 gateway voice RPC，此处提供状态与指引）
  bus.register('/voice', async (args) => {
    // W3 Voice 第 1 步：组合路由决策——modern/required 在 facade 接线完成前 fail-closed
    const { decideVoiceRoute } = await import('./voiceRouting.js');
    const voiceRoute = decideVoiceRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!voiceRoute.ok) {
      throw new Error(`[${voiceRoute.error.code}] ${voiceRoute.error.message}`);
    }
    const sub = args[0];
    const tip = 'TUI 内按 Ctrl+B 或点击麦克风钮开启语音（ffmpeg 录音 → whisper 本地转写 → 自动提交 → TTS 回复）；/voice status 查看组件可用性';
    if (sub === 'status') {
      const { checkVoice } = await import('../kernel/voice.js');
      const r = checkVoice((ctx.config.get('settings') as any) ?? {}, ctx.dataDir);
      const ready = r.sttAvailable && r.details.length > 0;
      return `语音组件：${ready ? '✅ 就绪' : '❌ 未就绪'}（${r.details.join('；') || 'whisper/ffmpeg 缺失——scripts/install-stt.mjs 安装'}）（${tip}）`;
    }
    if (sub === 'on' || sub === 'off') return '语音开关在 TUI 内使用（Ctrl+B 或麦克风钮）——非交互模式无语音输入';
    return `语音模式（${tip}）`;
  });

  // /fortune：运势（审查修复：此前仅 TUI 本地命令——注册进命令面保持一致）
  bus.register('/fortune', () => {
    const seeds = ['今日宜：编译小步走，验证早跑通。', '今日宜：先写规格，再写代码。', '今日宜：证据留痕，回滚无忧。', '今日宜：一条命令，一个闭环。', '今日忌：不探活就上线。', '今日忌：空谈概念，不落证据。'];
    return seeds[Math.floor(Math.random() * seeds.length)]!;
  });

  bus.register('/status', () => {
    const u = { model: ctx.getModel(), mode: ctx.getMode(), cwd: ctx.cwd };
    const s = (ctx.config.get('settings') ?? {}) as Record<string, any>;
    const sec = (s.security ?? {}) as Record<string, boolean>;
    const autoReview = s.autoReview === true;
    // 接入层/余额/成本一览（/cost 与状态栏同源数据）
    const providers = (Array.isArray(s.providers) ? s.providers : []) as Array<Record<string, any>>;
    const activeP = providers.find(p => p.id === s.activeProvider);
    const bm = (s.balanceMonitor ?? {}) as Record<string, any>;
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    let costLine = '暂无 API 用量（真实对话后 /cost 估算）';
    const cq = sessionCost(ctx.db, sid, (ctx.config.get('settings') as Record<string, any>)?.costPrices);
    if (cq) costLine = `${costText(cq)}（估算，本会话）`;
    return lines(' 状态 ', [
      ` 模型：${c(u.model || '未配置（/model set-key <密钥> 配置）', u.model ? '35' : '33')}`,
      ` 模式：${c(u.mode, '36')}`,
      ` 目录：${c(u.cwd, '36')}`,
      ` 命令：${c(`${SLASH.length} 个`, '36')}`,
      ` 档案：${activeP ? `${activeP.id}（${activeP.name}）` : providers.length ? '未切换（/profile use）' : '未配置（/profile add 接入任意端点）'}`,
      ` 余额监控：${bm.enabled === false ? '已关闭（/balance on）' : bm.url || activeP?.balanceUrl ? '已配置（状态栏 💰）' : '未配置（/balance set <余额URL>）'}`,
      ` 成本：${costLine}（/cost 看区间）`,
      ` 智能：${[
        autoReview ? 'AI 预审' : null,
        sec.sudoInjection ? 'sudo 通道' : null,
        sec.secretInjection ? 'secret 通道' : null,
        s.lowRiskAutoApprove !== false ? '低危放行' : null,
      ].filter(Boolean).join(' / ') || '标准'}`,
    ]);
  });

  bus.register('/doctor', () => {
    // 真实检测（对比轮 6 修复：此前四行硬编码"正常"）
    const checks: Array<[string, string]> = [];
    checks.push(['配置中心', existsSync(join(ctx.dataDir, 'settings.json')) ? '正常' : '未初始化']);
    // 数据库完整性：SQLite PRAGMA integrity_check 真实校验
    try {
      const r = ctx.db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string } | undefined;
      checks.push(['数据库', r?.integrity_check === 'ok' ? '正常' : `异常（${r?.integrity_check ?? '未知'}）`]);
    } catch { checks.push(['数据库', '异常（无法执行完整性检查）']); }
    // 记忆层：三层计数真实查询
    try {
      const total = (ctx.db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number }).c;
      const archived = (ctx.db.prepare(`SELECT COUNT(*) c FROM messages WHERE archived=1`).get() as { c: number }).c;
      checks.push(['黑洞记忆', `${total} 条（其中 ${archived} 条已归档压缩，仍可检索）`]);
    } catch { checks.push(['黑洞记忆', '异常（表不可读）']); }
    // FTS 索引可检索性
    try {
      const fts = (ctx.db.prepare(`SELECT COUNT(*) c FROM messages_fts`).get() as { c: number }).c;
      checks.push(['全文索引', `${fts} 条可检索`]);
    } catch { checks.push(['全文索引', '未初始化']); }
    // 密钥真实解密验证 + provider 归属校验（加密 ≠ 可用；归属不符会 401——fail-closed 不误发）
    const keyRes = resolveApiKey(ctx.config.get('settings') as Record<string, any>);
    if (keyRes.key) {
      checks.push(['模型密钥', `已配置且可解密（provider=${keyRes.provider}）`]);
    } else if (keyRes.error === 'provider-mismatch') {
      checks.push(['模型密钥', `provider 不符：${keyRes.hint}`]);
    } else if (keyRes.source === 'enc') {
      checks.push(['模型密钥', '已配置但无法解密（需 /model set-key 重配）']);
    } else {
      checks.push(['模型密钥', '未配置（/model set-key <密钥> 配置）']);
    }
    // 当前模型目录可用性
    const model = ctx.getModel();
    checks.push(['当前模型', model ? model : '未选择']);
    // 接入档案一致性（配置漂移防呆：active 指向/重复 id/baseURL 格式）
    try {
      const providers = ctx.config.getKey('settings', 'providers') as Array<Record<string, any>> | undefined;
      const active = ctx.config.getKey('settings', 'activeProvider') as string | undefined;
      const issues = profileHealth(providers, active);
      if (Array.isArray(providers) && providers.length) {
        checks.push(['接入档案', issues.length ? `异常：${issues[0]!.detail}` : `${providers.length} 个档案正常`]);
      } else {
        checks.push(['接入档案', '未配置（/profile add 接入任意 OpenAI 兼容端点）']);
      }
    } catch { /* 档案读取失败不阻断体检 */ }
    // 面板着色：键名 label 青、异常/未配置红、正常绿
    return lines(' 体检 ', checks.map(([k, v]) => ` ${c(k, '36')}：${/异常|未配置|无法/.test(v) ? c(v, '31') : /正常|可解密|可检索/.test(v) ? c(v, '32') : v}`));
  });

  // /login [平台] [密钥]：认证入口（对比轮 6 补强——平台选择 + 密钥录入 + 模型目录刷新）
  //   纯本地 API Key 认证（无 OAuth）；配置类行为，不产生 AI 对话输出
  bus.register('/yolo', (args) => {
    const on = args[0] !== 'off' && args[0] !== '0';
    ctx.setMode(on ? 'yolo' : 'smart');
    return on ? 'yolo 已开启：除硬红线外全部自动放行（注意风险）' : 'yolo 已关闭（回到 smart 更改前确认）';
  });

  // /afk：无人值守自动批准（参考 afk 同款；映射 yolo 语义 + 关闭提问）
  bus.register('/afk', (args) => {
    const on = args[0] !== 'off' && args[0] !== '0';
    ctx.setMode(on ? 'yolo' : 'smart');
    return on ? 'afk 已开启：无人值守自动批准（ask_user/clarify 自动通过，硬红线仍拦截）' : 'afk 已关闭（回到 smart 更改前确认）';
  });

  // 生命周期 Hooks（settings.hooks 本地命令）
  bus.register('/hooks', () => {
    const cfg = hooksFromConfig(ctx.config.get('settings'));
    if (!Object.keys(cfg).length) {
      return lines(' Hooks ', [
        ' 未配置（全事件关闭）',
        '',
        ' 在 data/settings.json 的 settings.hooks 配置本地命令：',
        '  "hooks": {',
        '    "userPromptSubmit": "node C:/notify.js",',
        '    "preToolUse": "echo DENY 安全规则拦截",',
        '    "postToolUse": "echo 工具完成",',
        '    "stop": "node C:/on-stop.js"',
        '  }',
        ' 上下文经环境变量传入：WXNODUS_HOOK_EVENT / WXNODUS_HOOK_DATA(JSON)',
        ' preToolUse 输出 DENY 开头即拦截工具执行；命令 10s 超时，失败不阻断',
      ]);
    }
    return lines(' Hooks ', HOOK_EVENTS.map(ev => ` ${cfg[ev] ? '✓' : '○'} ${ev}${cfg[ev] ? ' → ' + cfg[ev] : ''}`));
  });

  // 密钥（per-provider 槽位：apiKeys.<provider> 归属存储；遗留 apiKeyEnc+keyProvider 兼容）
  // 已并入 /model：密钥配置 → /model set-key，密钥状态 → /model key（原 /key 命令移除）

  bus.register('/version', () => `WxNodus ${WXNODUS_VERSION}`);

  // 更新检查（分发闭环 S0）：诚实报告安装渠道/版本/仓库状态与确切更新命令；
  // git 渠道在有 remote 且工作树干净时 --yes 执行 pull+build，其余渠道只给命令绝不代执行。
  bus.register('/update', async (args) => {
    const { buildUpdateReport, channelLabel } = await import('./updateCheck.js');
    const report = buildUpdateReport({ modulePath: import.meta.url, cwd: ctx.cwd ?? process.cwd() });
    const base = lines(' 更新检查 ', [
      ` 版本：${report.version}`,
      ` 安装渠道：${channelLabel(report.channel)}`,
      ...(report.installMeta ? [` 安装包：${report.installMeta.app} v${report.installMeta.version}${report.installMeta.installedAt ? ` @ ${report.installMeta.installedAt}` : ''}`] : []),
      ...(report.git?.isRepo ? [` 仓库：HEAD ${report.git.head} @ ${report.git.date}（${report.git.clean ? '干净' : '有未提交改动'}）${report.git.remote ? '' : '——未配置 origin'}`] : []),
      ` 更新方式：${report.guidance}`,
    ]);
    // zip 渠道记录过安装源（-Source 透传）→ 真实远程版本探测；失败诚实降级
    if (report.installMeta?.source) {
      const { probeRemoteVersion } = await import('./updateCheck.js');
      const remote = await probeRemoteVersion(report.installMeta.source);
      return base + (remote.ok
        ? `\n 远程最新：${remote.version}（安装源 ${report.installMeta.source}）\n 升级：下载新版 zip → 解压 → 双击 install.bat 幂等覆盖（数据保留）`
        : `\n 远程探测失败：${remote.message}（离线渠道诚实降级）`);
    }
    if (!report.canAutoUpdate) return base + (args.includes('--yes') ? '\n --yes 不可用：仅 git 渠道 + 已配置 remote + 工作树干净时可执行（当前不满足，已拒绝）。' : '');
    if (!args.includes('--yes')) return base + '\n 可用 /update --yes 自动执行（git pull && npm install && npm run build，需确认）。';
    try {
      const { execSync } = await import('node:child_process');
      const repo = (await import('./updateCheck.js')).findRepoRoot(import.meta.url) ?? ctx.cwd;
      const out = execSync('git pull && npm install && npm run build', { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      try { appendAudit(ctx.db, 'update.git-pull', { repo, version: report.version }); } catch { /* 审计表未就绪静默 */ }
      return base + `\n 已执行 git pull && npm install && npm run build\n${String(out).slice(-600)}`;
    } catch (e: any) {
      return base + `\n 更新执行失败：${String(e?.message ?? e).slice(0, 300)}（工作树未动——git pull 失败不会改本地）`;
    }
  });

  // 模式（Claude Code 五模式体系：smart 更改前确认 / auto 自动编辑 / goal loop-goal /
  // manual 全量确认 / plan 计划模式 / yolo 完全访问）
  bus.register('/perm', async (args) => {
    const mode = args[0];
    // P1-4 会话授权子命令（approve_for_session，gap 2026-08-18）：
    //   session-list ｜ session-allow <tool> <key> ｜ session-deny <tool> <key> ｜ session-revoke [tool] [key]
    if (mode === 'session-list' || mode === 'session-allow' || mode === 'session-deny' || mode === 'session-revoke') {
      const { listSessionGrants, grantSession, revokeSessionGrant } = await import('../kernel/sessionGrants.js');
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      if (mode === 'session-list') {
        const rows = listSessionGrants(ctx.db, sid);
        if (!rows.length) return `会话 ${sid} 暂无授权记录（settings.approveForSession=true 后批准一次即自动记录；/perm session-allow 手动添加）`;
        return lines(' 会话授权 ', rows.map(r => ` ${r.kind === 'deny' ? '✗deny' : '✓allow'} ${r.tool} ${r.key.slice(0, 60)}（${new Date(r.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}）`));
      }
      const tool = args[1];
      const key = args.slice(2).join(' ');
      if (!tool) return '用法：/perm session-allow|session-deny <tool> <key>（bash 填完整命令；fs_write/fs_edit 填 path）';
      if (mode === 'session-revoke') {
        const n = revokeSessionGrant(ctx.db, sid, key ? tool : undefined, key || undefined);
        return `已撤销 ${n} 条会话授权（${key ? `${tool} ${key.slice(0, 40)}` : tool ?? '全部'}）`;
      }
      const grantArgs = tool === 'bash' ? { command: key } : (tool === 'fs_write' || tool === 'fs_edit') ? { path: key } : { key };
      grantSession(ctx.db, sid, tool, grantArgs, mode === 'session-allow' ? 'allow' : 'deny');
      return `会话授权已记录：${mode === 'session-allow' ? '✓allow' : '✗deny'} ${tool} ${key.slice(0, 60)}（本会话内生效，/perm session-revoke 撤销）`;
    }
    if (mode && ['smart', 'auto', 'manual', 'plan', 'yolo', 'goal'].includes(mode)) {
      const from = ctx.getMode();
      ctx.setMode(mode);
      // A21：模式切换落审计（哈希链）
      try { appendAudit(ctx.db, 'mode.changed', { from, to: mode, source: 'cmd' }); } catch { /* 审计表未就绪静默 */ }
      return `模式已切换：${mode}`;
    }
    return '当前模式：' + ctx.getMode() + '（可选：smart 更改前确认 / auto 自动编辑 / goal loop-goal / manual 全量确认 / plan 计划模式 / yolo 完全访问）';
  });

  // 模型与密钥统一入口（/key 已并入）：
  //   /model            → 打开选择器（含「＋ 添加自定义接口」表单与密钥段）
  //   /model <模型ID>   → 切换（目录/档案命中直切）
  //   /model add <模型ID[,ID2]> --base <URL> [--name 名称] [--key 密钥] → 添加任意 OpenAI 兼容接口
  //   /model set-key <密钥> [--provider <档案id>] → 密钥配置
  //   /model key        → 密钥状态
  bus.register('/model', (args) => {
    const sub = args[0] ?? '';
    // /model set-key <密钥> [--provider <档案id>]：密钥配置（原 /key set 迁入——单一写入路径 modelRegistry.applyModelKey）
    if (sub === 'set-key') {
      const pi = args.indexOf('--provider');
      const providerTarget = pi >= 0 ? String(args[pi + 1] ?? '').trim() : '';
      const secret = args.slice(1, pi >= 0 ? pi : args.length).join(' ').trim();
      if (!secret) return '用法：/model set-key <密钥> [--provider <档案id>]（AES-256-GCM 加密存储，绝不回显；不带密钥可在选择器内配置）';
      return applyModelKey(ctx.config, secret, providerTarget ? { profileId: providerTarget } : {});
    }
    // /model key：密钥状态（原 /key status 迁入）
    if (sub === 'key') {
      const settings = ctx.config.get('settings') as Record<string, any>;
      const keyRes = resolveApiKey(settings);
      if (!keyRes.key) {
        if (keyRes.error === 'provider-mismatch') return `密钥状态：${c('provider 不符', '33')}——${keyRes.hint}`;
        return `密钥状态：${c('未配置', '33')}——/model set-key <密钥> 配置后获得完整能力`;
      }
      // 验证可解密 + 展示归属（per-provider 槽位多 key 时列出全部 provider）
      const dec = keyRes.key;
      const apiKeys = (settings.apiKeys as Record<string, string> | undefined) ?? {};
      const decrypted = Object.entries(apiKeys).map(([p, e]) => `${p}:${decryptKey(e) ? c('✓', '32') : c('✗', '31')}`).join(' ');
      const extra = Object.keys(apiKeys).length > 1 ? `（各 provider：${decrypted}）` : '';
      return keyRes.source === 'enc'
        ? `密钥状态：${c('已配置', '32')}（${maskKey(dec)} · provider=${keyRes.provider}）${extra}`
        : `密钥状态：${c('已配置（环境变量）', '32')}（${maskKey(dec)} · provider=${keyRes.provider}）`;
    }
    // /model add：添加任意 OpenAI 兼容接口（选择器表单同一写入路径 modelRegistry.addCustomModel）
    if (sub === 'add') {
      const parsed = parseModelAddArgs(args.slice(1));
      if (!parsed) return '用法：/model add <模型ID[,模型ID2]> --base <接口地址> [--name <名称>] [--key <密钥>]（任意 OpenAI 兼容端点）';
      try {
        const r = addCustomModel(ctx.config, parsed, (event, payload) => {
          try { appendAudit(ctx.db, event, payload); } catch { /* 审计表未就绪静默 */ }
        });
        return r.message;
      } catch (e: any) { return `添加失败：${String(e?.message ?? e).slice(0, 120)}`; }
    }
    const q = args.join(' ');
    if (q) {
      // UI 模型选择器传入的是命令串（"modelId --provider slug [--global|--session]"），
      // 取第一个 token 作为 modelId（modelId 不含空格）
      const clean = q.split(/\s+/)[0] ?? q;
      const s = clean.toLowerCase();
      const hit = MODEL_CATALOG.find(m => m.name.toLowerCase() === s || m.modelId.toLowerCase() === s);
      if (!hit) {
        // 接入层开放闭环：档案模型可经 /model 直达（选择器同链路）——命中即切换
        // activeProvider + baseURL（resolveModelForChat 任意模型名放行的对应 UI 面）
        const providers = (Array.isArray(ctx.config.getKey('settings', 'providers')) ? ctx.config.getKey('settings', 'providers') : []) as Array<Record<string, any>>;
        const pHit = providers.find(p => (p.models ?? []).some((mid: string) => String(mid).toLowerCase() === s));
        if (pHit) {
          ctx.config.setKey('settings', 'activeProvider', pHit.id);
          ctx.setModel(clean, pHit.baseURL);
          return `已切换档案模型：${clean}（档案 ${pHit.id} · ${pHit.name}）`;
        }
        const filtered = filterModels(q);
        const list = filtered.length ? filtered : MODEL_CATALOG;
        const profileRows = providers.flatMap(p => (p.models ?? []).map((mid: string) => ` ${mid}（档案 ${p.id} · ${p.name}）`));
        // 参考价目后缀（USD/1M；未收录定价不显示——诚实）
        const priceSuffix = (modelId: string) => {
          const pr = priceForModel(modelId);
          if (!pr) return '';
          return pr.in === 0 && pr.out === 0 ? '（免费）' : `（≈$${pr.in}/$${pr.out} M）`;
        };
        return lines(' 模型目录 ', [`未找到「${q}」${filtered.length || profileRows.length ? '，相近模型：' : '，可用模型：'}`, ...list.map(m => ` ${m.name}（${m.provider}）${capabilityBadges(m.capabilities)}${priceSuffix(m.modelId)}`), ...profileRows.slice(0, 8)]);
      }
      ctx.setModel(hit.modelId, hit.baseURL);
      return `已切换模型：${hit.name}（${hit.provider}）${capabilityBadges(hit.capabilities)}`;
    }
    ctx.openModelPicker();
    // 诚实回退：无 TUI 时选择器不可用——给出文本用法而非空输出（TUI 内由本地 slash 拦截，不会到达此处）
    return '模型选择器需交互界面——文本模式：/model <关键词> 模糊搜索切换 · /model list 目录 · /model add <名> <baseURL> 自定义接口 · /model set-key <密钥> 配置';
  });

  bus.register('/thinking', (args) => {
    const v = args[0];
    if (v === 'on' || v === 'off' || v === '1' || v === '0' || v === 'true' || v === 'false') {
      const on = v === 'on' || v === '1' || v === 'true';
      ctx.setThinking(on);
      return `推理显示：${on ? '开' : '关'}`;
    }
    return '用法：/thinking on|off（模型选择器中 [←→] 也可切换）';
  });

  bus.register('/theme', (args) => {
    const name = args[0];
    if (name) {
      // 2026-08-19 用户主题（opencode themeSource.discover 对标）：解析含 dataDir/themes/*.json；
      // 未知主题诚实拒绝——绝不「已切换」假反馈（此前未知名也报切换成功）
      const user = loadUserThemes(ctx.dataDir);
      const resolved = themeByName(name, process.env, user.presets);
      if (!resolved) {
        const userNames = Object.keys(user.presets).join(' / ');
        return `未知主题：${name}（内置 dark/light/${themePresetNames().filter(n => n !== 'dark' && n !== 'light').join('/')}${userNames ? `；用户 ${userNames}` : ''}）——未切换`;
      }
      ctx.setTheme(name);
      // 事件携带已解析主题对象——UI 侧直接应用（用户主题三元组随事件到达），不再二次解析
      ctx.bus.emit('theme.changed', { name, theme: resolved });
      return `主题已切换：${name}`;
    }
    const user = loadUserThemes(ctx.dataDir);
    const extras = Object.keys(user.presets);
    return `当前主题：${ctx.getThemeName()}
可选预设：dark / light / ${themePresetNames().filter(n => n !== 'dark' && n !== 'light').join(' / ')}${extras.length ? `\n用户主题：${extras.join(' / ')}` : ''}${user.warnings.length ? `\n主题加载警告：${user.warnings.slice(0, 3).join('；')}${user.warnings.length > 3 ? ' …' : ''}` : ''}`;
  });

  // W7-00：主工作区（用户动态指定）——查看/设置/重置；持久化 settings.workspace
  // （下次启动工具管线边界随之切换；命令层经 getter 即时生效）
  bus.register('/workspace', (args) => {
    const sub = args[0];
    if (!sub || sub === 'show') {
      const root = ctx.workspaceRoot ?? ctx.cwd;
      return `主工作区：${root}\n来源：${ctx.workspaceSource ?? 'cwd'}\n设置：/workspace set <绝对目录> [--create]\n重置：/workspace reset`;
    }
    if (sub === 'set') {
      const dir = args[1];
      if (!dir) return '用法：/workspace set <绝对目录> [--create]';
      if (!isAbsolute(dir)) return 'WORKSPACE_INVALID：必须是绝对路径（如 C:/Users/you/work）';
      if (!existsSync(dir)) {
        if (args.includes('--create')) {
          try { mkdirSync(dir, { recursive: true }); } catch (cause) { return `WORKSPACE_CREATE_FAILED: ${String((cause as Error).message ?? cause)}`; }
        } else {
          return 'WORKSPACE_NOT_FOUND：目录不存在（加 --create 自动创建）';
        }
      }
      ctx.setWorkspace?.(dir);
      return `主工作区已设置：${dir}（已持久化；命令层即时生效，工具管线边界下次启动生效）`;
    }
    if (sub === 'reset') {
      ctx.setWorkspace?.(null);
      return `主工作区已重置：${ctx.cwd}（默认项目文件夹）`;
    }
    return '用法：/workspace [show|set <dir> [--create]|reset]';
  });

  // W7-01：下载框架——URL → 主工作区内原子落盘（SSRF 逐跳授权 + 双上限 + sha256 证据）
  bus.register('/download', async (args) => {
    const url = args[0];
    if (!url) return '用法：/download <url> [--out <工作区内目录>]（默认落 <工作区>/downloads）';
    const root = ctx.workspaceRoot ?? ctx.cwd;
    const outIdx = args.indexOf('--out');
    const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
    const destDir = outArg ? (isAbsolute(outArg) ? outArg : join(root, outArg)) : join(root, 'downloads');
    if (!ctx.download) return '下载服务未装配（fail-closed，不回退）';
    const r = await ctx.download(url, destDir);
    if (!r.ok) return `下载失败：${r.error.code}${r.error.details ? ` ${JSON.stringify(r.error.details)}` : ''}`;
    return `已下载：${r.value.filePath}（${r.value.bytes} 字节 · sha256=${r.value.sha256}）`;
  });

  // W7-03：黑洞检索——默认记忆检索（原 /hole 语义）；--code 扩展同化语料（代码/插件/MCP，来源标注）
  bus.register('/hole', async (args) => {
    const codeIdx = args.indexOf('--code');
    if (codeIdx >= 0) {
      const rest = args.slice(codeIdx + 1);
      const limit = (() => {
        const i = rest.indexOf('--limit');
        const n = Number(rest[i + 1]);
        return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 10;
      })();
      const q = rest.filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--limit').join(' ').trim();
      if (!q) return '用法：/hole --code <关键词> [--limit N]（代码/模块/插件/MCP 同化语料——先 /assimilate --code <目录> 等）';
      if (!ctx.codeIndex) return '代码同化索引未装配（fail-closed）';
      const hits = ctx.codeIndex.search(q, { limit });
      if (!hits.length) return `未检索到与「${q}」相关的代码/插件/MCP 语料（先 /assimilate --code <目录> / --plugins / --mcp）`;
      return lines(` 黑洞检索「${q}」(${hits.length} 条) `, hits.map(h => {
        if (h.source === 'code') return ` [代码] ${h.path}${h.head ? ` · ${h.head}` : ''}`;
        return ` [${h.source === 'plugin' ? '插件' : 'MCP'}] ${h.id} · ${h.title}`;
      }));
    }
    // 波 3 ⑪：跨会话语义召回（六家独有的本地实现——FTS5 中文 bigram + 本地向量 KNN 全会话检索，
    // 数据不出机；aider 仅本地嵌入做 /help 文档 RAG、gemini 云端嵌入、其余纯正则——取证确认）
    if (args[0] === '--all') {
      const rest = args.slice(1);
      const limit = (() => {
        const i = rest.indexOf('--limit');
        const n = Number(rest[i + 1]);
        return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 10;
      })();
      const q = rest.filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--limit').join(' ').trim();
      if (!q) return '用法：/hole --all <关键词> [--limit N]（本地跨会话语义召回——FTS bigram + 本地向量 KNN，全会话检索，数据不出机）';
      const hits = await ctx.mem.recallHybrid(q, { limit }); // sessionId 缺省 = 全局召回（跨会话）
      if (!hits.length) return `跨会话召回未命中与「${q}」相关的记忆（本地检索，无云端依赖）`;
      return lines(` 跨会话语义召回「${q}」(${hits.length} 条 · 本地) `, hits.map(h => {
        const sid = h.session_id ? `会话 ${String(h.session_id).slice(0, 12)}` : '未知会话';
        return ` [${sid}] ${snippet(h.content, 56)}（score ${h.score.toFixed(2)}）`;
      }));
    }
    // 默认：记忆检索（与 /memory search 同一权威层）
    const q = args.filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--limit').join(' ').trim();
    if (!q) return '用法：/hole <关键词>（记忆检索）｜ /hole --all <关键词>（跨会话语义召回）｜ /hole --code <关键词>（代码/插件/MCP 同化语料）';
    const limit = (() => {
      const i = args.indexOf('--limit');
      const n = Number(args[i + 1]);
      return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 10;
    })();
    const svc = ctx.memoryServiceFor ? ctx.memoryServiceFor(ctx.agent?.getSessionId?.() ?? 'default') : null;
    if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed，不回退 legacy）';
    const result = svc.search({ text: q, limit });
    if (!result.ok) return `记忆检索失败：${result.error.code}`;
    const hits = result.value;
    if (!hits.length) return `未检索到与「${q}」相关的记忆`;
    return lines(` 记忆检索「${q}」(${hits.length} 条) `, hits.map(h => {
      const when = new Date(h.record.updatedAt).toLocaleString();
      return ` [${h.record.id}] ${snippet(h.record.content, 70)}（${when}）`;
    }));
  });

  bus.register('/memory', async (args) => {
    const rec = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default');
    const absorbed = ctx.mem.absorbCount('default');
    const sub = args[0];

    // W3 Memory 影子观察：/memory shadow —— 两模型计数 + 影子健康 + 召回来源诚实声明
    if (sub === 'shadow') {
      const report = (ctx.mem as { shadowReport?(sessionId: string): unknown }).shadowReport?.(ctx.agent?.getSessionId?.() ?? 'default');
      if (!report) return '影子双写未启用（modern memory shadow 未装配）';
      const r = report as { legacyMessages: number; shadowRecords: number; shadowAppends: number; shadowFailures: number; lastError: string | null; recallSource: string };
      return lines(' 记忆影子观察（观察期——召回不回切） ', [
        ` legacy 消息：${c(`${r.legacyMessages} 条`, '36')}（唯一行为事实源）`,
        ` modern 显式记录：${c(`${r.shadowRecords} 条`, '35')}（session scope 影子写）`,
        ` 影子写：${r.shadowAppends} 次 · 失败 ${c(`${r.shadowFailures} 次`, r.shadowFailures ? '31' : '37')}${r.lastError ? `（最近：${r.lastError}）` : ''}`,
        ` 召回来源：${r.recallSource}——一致性验证后另定召回策略（绝不静默回切）`,
      ]);
    }

    // W3 Memory：modern 权威分支——search/delete/update/pin|fade|reset/list 全部经 session-scoped
    // MemoryService（scope 只来自当前会话）；端口缺失时诚实 fail-closed（绝不静默回退 legacy 假成功）
    const svcFor = (): import('../application/memoryService.js').MemoryService | null =>
      ctx.memoryServiceFor ? ctx.memoryServiceFor(ctx.agent?.getSessionId?.() ?? 'default') : null;

    // 检索——/memory search <词> [--limit N]
    if (sub === 'search') {
      const q = args
        .slice(1)
        .filter((a, i, arr) => {
          if (a.startsWith('--')) return false;
          return arr[i - 1] !== '--limit';
        })
        .join(' ')
        .trim();
      if (!q) return '用法：/memory search <关键词> [--limit N]（modern 显式记忆记录，会话隔离）';
      const limit = (() => {
        const i = args.indexOf('--limit');
        const n = Number(args[i + 1]);
        return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 10;
      })();
      const svc = svcFor();
      if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed，不回退 legacy）';
      const result = svc.search({ text: q, limit });
      if (!result.ok) return `记忆检索失败：${result.error.code}`;
      const hits = result.value;
      if (!hits.length) return `未检索到与「${q}」相关的记忆`;
      return lines(` 记忆检索「${q}」(${hits.length} 条) `, hits.map(h => {
        const when = new Date(h.record.updatedAt).toLocaleString();
        return ` [${h.record.id}] ${snippet(h.record.content, 70)}（${when}）`;
      }));
    }

    // 删除——/memory delete <id>（字符串 id）
    if (sub === 'delete') {
      const id = String(args[1] ?? '').trim();
      if (!id) return '用法：/memory delete <记忆id>（id 见 /memory list）';
      const svc = svcFor();
      if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed，不回退 legacy）';
      const result = svc.delete(id);
      if (!result.ok) return `记忆 ${id} 不存在或越权（${result.error.code}）`;
      return `已删除记忆 ${id}（FTS 索引同步清理）`;
    }

    // 改写——/memory update <id> <新内容>
    if (sub === 'update') {
      const id = String(args[1] ?? '').trim();
      const content = args.slice(2).join(' ').trim();
      if (!id || !content) return '用法：/memory update <记忆id> <新内容>（id 见 /memory list）';
      const svc = svcFor();
      if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed，不回退 legacy）';
      const result = svc.update(id, { content });
      if (!result.ok) return `记忆 ${id} 不存在或越权（${result.error.code}）`;
      return `已更新记忆 ${id}（FTS 同步）`;
    }

    // 置顶/淡化——/memory pin|fade|reset <id> [倍率]（modern salience 更新）
    if (sub === 'pin' || sub === 'fade' || sub === 'reset') {
      const id = String(args[1] ?? '').trim();
      if (!id) return '用法：/memory pin|fade|reset <记忆id> [倍率]（id 见 /memory list）';
      const mult = sub === 'reset' ? 1 : Number(args[2] ?? (sub === 'pin' ? 3 : 0.3));
      if (!Number.isFinite(mult) || mult <= 0) return '倍率需为正数（pin 建议 3，fade 建议 0.3，范围 0.05-10）';
      const svc = svcFor();
      if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed，不回退 legacy）';
      // legacy 倍率语义 → modern salience[0,1] 单调映射（见 memorySalience.ts）
      const result = svc.update(id, { salience: salienceFromMultiplier(mult) });
      if (!result.ok) return `记忆 ${id} 不存在或越权（${result.error.code}——/memory list 查看可用 id）`;
      const label = sub === 'pin' ? '置顶' : sub === 'fade' ? '淡化' : '还原';
      return `已${label}记忆 ${id}（salience ×${mult}）——/memory list 查看置顶项`;
    }

    // 波 2 ⑪：记忆收件箱（gemini .inbox 对标）——审阅 AI 写入的候选记忆：apply 批准
    // 生效（写入 modern 记忆层）/ discard 丢弃 / undo 按记录撤销（可审可退，
    // 堵「不可控记忆」评审攻击）；settings.memoryInbox=true 时 memory_write 先入箱
    if (sub === 'inbox') {
      const op = String(args[1] ?? 'list').trim();
      const id = String(args[2] ?? '').trim();
      const { ensureMemoryInbox, inboxList, inboxMark, inboxGet } = await import('../kernel/memoryInbox.js');
      ensureMemoryInbox(ctx.db);
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      if (op === 'list') {
        const rows = inboxList(ctx.db, sid, 'pending');
        if (!rows.length) return '收件箱为空（无待审记忆）——settings.memoryInbox=true 时 AI 写入先入箱待审';
        return lines(' 记忆收件箱（待审） ', rows.map(r => ` [${r.id}] ${snippet(r.content, 60)}（${new Date(r.ts).toLocaleString()}）`));
      }
      if (!id) return '用法：/memory inbox list | apply <id> | discard <id> | undo <id>';
      if (op === 'apply') {
        const row = inboxGet(ctx.db, id);
        if (!row) return `收件箱无此记录：${id}`;
        if (row.status !== 'pending') return `记录 ${id} 状态为 ${row.status}（仅 pending 可批准）`;
        const svc = svcFor();
        if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed）';
        const result = svc.append({
          role: 'assistant',
          content: row.content,
          salience: 0.5,
          retention: { class: 'session', retainUntil: null },
          provenance: {
            sourceType: 'tool', sourceId: sid, sourceUri: undefined,
            capturedAt: new Date().toISOString(), actorId: sid,
            correlationId: 'memory_inbox_apply', policySnapshotId: 'inbox', sourceTrust: 1,
          },
        });
        if (!result.ok) return `批准失败：${result.error.code}`;
        inboxMark(ctx.db, id, 'applied', result.value.record.id);
        return `已批准记忆 ${id} 生效（modern 记录 ${result.value.record.id}）——/memory search 可检索；/memory inbox undo ${id} 可撤销`;
      }
      if (op === 'discard') {
        if (!inboxMark(ctx.db, id, 'discarded')) return `收件箱无此记录：${id}`;
        return `已丢弃记忆 ${id}（未进记忆库）`;
      }
      if (op === 'undo') {
        const row = inboxGet(ctx.db, id);
        if (!row) return `收件箱无此记录：${id}`;
        if (row.status !== 'applied' || !row.memory_record_id) return `记录 ${id} 无可撤销的生效状态（status=${row.status}）`;
        const svc = svcFor();
        if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed）';
        const result = svc.delete(row.memory_record_id);
        if (!result.ok) return `撤销失败：${result.error.code}`;
        inboxMark(ctx.db, id, 'reverted');
        return `已撤销记忆 ${id}（modern 记录 ${row.memory_record_id} 已删除）`;
      }
      return '用法：/memory inbox list | apply <id> | discard <id> | undo <id>';
    }

    // 列表——/memory list [N]（modern 显式记录，updated_at 降序）
    if (sub === 'list') {
      const n = Math.min(Number(args[1] ?? 10) || 10, 30);
      const svc = svcFor();
      if (!svc) return '记忆权威层未装配（memoryServiceFor 缺失——fail-closed，不回退 legacy）';
      const result = svc.list({ limit: n });
      if (!result.ok) return `记忆列表失败：${result.error.code}`;
      const records = result.value;
      if (!records.length) return lines(' 记忆（modern 显式记录） ', [' 无显式记忆记录（对话影子写见 /memory shadow）']);
      return lines(' 记忆（modern 显式记录，/memory pin|fade <id> 加权） ', records.map(m => {
        const flag = salienceFlag(m.salience);
        return ` ${flag} [${m.id}] [${m.role}] ${snippet(String(m.content), 60)}${flag === '★' ? `（×${m.salience.toFixed(2)}）` : ''}`;
      }));
    }

    const salient = ctx.mem.listSalient();
    return lines(' 记忆 ', [
      ` 全量消息：${c(`${rec.length} 条`, '36')}`,
      ` 已吸附归档：${c(`${absorbed} 条`, '35')}（黑洞引擎）`,
      ` 窗口：${Math.min(rec.length, 20)}/20`,
      ' modern：/memory list 查看显式记忆 · /memory shadow 观察双写',
      ...(salient.length
        ? [` 置顶记忆：${c(`${salient.length} 条`, '33')}（召回加权优先）`,
           ...salient.slice(0, 8).map(s => `   ★ #${s.id} ×${s.salience} ${snippet(s.content, 40)}`)]
        : [` 置顶记忆：无（/memory pin <id> 可把核心约束置顶，召回恒优先）`]),
    ]);
  });

  // 需求编译（超复杂项目能力）
  bus.register('/build', async (args) => {
    // W3 Build 第 1 步：组合路由决策——modern/required 在 BuildService 生产接线完成前
    // fail-closed（BUILD_MODERN_UNAVAILABLE），绝不静默退回 legacy 假成功
    const { decideBuildRoute } = await import('./buildRouting.js');
    const buildRoute = decideBuildRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!buildRoute.ok) {
      throw new Error(`[${buildRoute.error.code}] ${buildRoute.error.message}`);
    }
    // A21：--dry-run——只编译（规格诊断 + 计划预览），零副作用；P2-2：--strict——门禁未过标记失败
    const dryRun = args.includes('--dry-run');
    const strict = args.includes('--strict');
    const input = args.filter(a => a !== '--dry-run' && a !== '--strict').join(' ');
    if (!input) return '用法：/build <需求> [--dry-run]（自然语言「做个待办系统」亦可直达）';
    // 单通道：AI 规格化是唯一编译通道（规则脑已移除）——无 key 立即报错，绝不假装编译
    const settings = ctx.config.get('settings') as { apiKeyEnc?: string | null; baseURL?: string; model?: string };
    const { resolveApiKey, MODEL_CATALOG } = await import('../kernel/providers.js');
    const keyRes = resolveApiKey(settings);
    if (!keyRes.key) {
      return '需求无法编译——AI 规格化是唯一编译通道，需要模型密钥。请先 /model set-key <密钥> 配置后重试；或说「/help build」';
    }
    const { aiMakeSpec } = await import('../build/llmSpec.js');
    const model = settings.model && MODEL_CATALOG.some(m => m.modelId === settings.model)
      ? settings.model
      : resolveDefaultModel(settings);
    const spec = await aiMakeSpec(input, { baseURL: resolveDefaultBaseURL(settings), model, key: keyRes.key });
    if (!spec) {
      return `需求无法编译（${input.slice(0, 30)}…）——AI 规格化失败（检查模型配置或重试）`;
    }
    // 计划构造（Spec v2，2026-08-19）：AI 分解（spec.modules）→ 真实模块 DAG 计划；
    // 缺失 = 简单需求——单模块计划 + 模具模板（向后兼容，规则脑已移除）
    const { topoSort } = await import('../build/plan.js');
    const plan = spec.modules?.length
      ? {
          modules: spec.modules.map(m => ({ name: m.name, deps: m.deps, desc: m.desc })),
          order: topoSort(spec.modules.map(m => ({ name: m.name, deps: m.deps }))),
          milestones: spec.modules.map((m, i) => `M${i + 1} ${m.name}`),
        }
      : {
          modules: [{ name: 'app', deps: [], desc: '单模块应用' }],
          order: ['app'],
          milestones: ['M1 应用构建', 'M2 验证与交付'],
        };
    // W3 Build facade：modern 路由走 BuildService.compileAndRun（staging→scaffold→staticEntry→verifier→evidence→reviewer→owned receipt）。
    // spec→结构化验收（模具锚点；未知模具 fail-closed）；快照真实来源（env/capability/hooks 确定性哈希）；
    // reviewer 密钥 AES 持久化（明文绝不落盘）。
    if (buildRoute.value.route === 'modern') {
      const { createHash } = await import('node:crypto');
      const { join } = await import('node:path');
      const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
      const { specToAcceptance } = await import('../build/specAcceptance.js');
      const criteria = specToAcceptance(spec);
      if (!criteria.ok) {
        throw new Error(`[${criteria.error.code}] ${criteria.error.message}（模具 ${spec.scaffold} 无结构化验收——现代编译拒绝）`);
      }
      const projName = `p${Date.now().toString(36)}`;
      const projDir = join(ctx.dataDir, 'projects', projName);
      const runId = `build-${Date.now().toString(36)}`;
      // 快照：environment（平台确定性）、capability（内置 verifier 能力并集）、policy（hooks 配置确定性哈希）
      const { BUILTIN_VERIFIER_DESCRIPTORS } = await import('../domain/quality/verifier.js');
      const capabilityIds = [...new Set(Object.values(BUILTIN_VERIFIER_DESCRIPTORS).flatMap(d => d.requiredCapabilities))].sort();
      const envBody = JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version });
      const capBody = JSON.stringify(capabilityIds);
      const { hooksFromConfig } = await import('../kernel/hooks.js');
      const policyBody = JSON.stringify(hooksFromConfig(ctx.config.get('settings') as Record<string, unknown> | undefined));
      const { createProductionBuildWiring } = await import('../application/build/buildServiceWiring.js');
      const { FileEvidenceStore } = await import('../infrastructure/quality/fileEvidenceStore.js');
      const { FileReviewNonceStore } = await import('../infrastructure/quality/fileReviewNonceStore.js');
      const { createReviewerKeyService } = await import('../application/quality/reviewerKeyService.js');
      const { encryptKey, decryptKey } = await import('../kernel/providers.js');
      const keyService = createReviewerKeyService({ dataDir: ctx.dataDir, encrypt: encryptKey, decrypt: decryptKey });
      const bundle = await keyService.loadOrCreate();
      if (!bundle.ok) throw new Error(`[${bundle.error.code}] ${bundle.error.message}`);
      const wiring = createProductionBuildWiring({
        dataDir: ctx.dataDir,
        runId,
        sessionId: ctx.agent?.getSessionId?.() ?? 'default',
        // AI 规格化 spec 驱动脚手架（criteria 仅验收断言）；
        // Spec v2：复杂需求（spec.modules）→ 逐模块生成引擎；简单需求 → 模具模板（原路径不变）
        instantiate: (async (_criteria: unknown, stagingDir: string) => {
          if (spec.modules?.length) {
            const { generateProject } = await import('../build/generate.js');
            const r = await generateProject({
              spec,
              plan,
              projectDir: stagingDir,
              deps: { baseURL: resolveDefaultBaseURL(settings), model, key: keyRes.key! },
              progress: (stage) => {
                try { ctx.bus.emit('system.notice', { text: `⛏ /build「${spec.title}」：${stage}` }); } catch { /* 静默 */ }
              },
            });
            return r.ok
              ? { ok: true as const }
              : { ok: false as const, error: { code: 'BUILD_GENERATE_FAILED', message: r.reason ?? '生成失败', messageKey: 'BUILD_GENERATE_FAILED', retryable: false } };
          }
          return instantiate(spec, stagingDir, plan) as never;
        }) as unknown as import('../application/build/buildServiceWiring.js').InstantiateLike,
        verifyProject: async (dir) => {
          const { verifyProject: legacyVerify } = await import('../build/verify.js');
          return legacyVerify(dir);
        },
        evidenceStore: new FileEvidenceStore(join(ctx.dataDir, 'evidence'), () => new Date().toISOString()) as never,
        snapshots: {
          environment: () => ({ ok: true as const, value: { snapshotId: `env-${process.platform}-${process.arch}`, sha256: sha256(envBody), platform: process.platform, arch: process.arch } }),
          capability: () => ({ ok: true as const, value: { snapshotId: 'cap-builtin-verifiers', sha256: sha256(capBody) } }),
          policy: () => ({ ok: true as const, value: { snapshotId: 'policy-hooks', sha256: sha256(policyBody), decisionId: 'hooks-config' } }),
        },
        reviewerSigner: bundle.value.signer,
        reviewerTrust: bundle.value.trustPolicy,
        nonceStore: new FileReviewNonceStore(join(ctx.dataDir, 'review-nonces')),
        makerActorId: 'wxnodus-build',
        reviewerActorId: 'reviewer',
      });
      if (!wiring.ok) throw new Error(`[${wiring.error.code}] ${wiring.error.message}`);
      const { BuildService } = await import('../application/build/buildService.js');
      const service = new BuildService(wiring.value.ports, wiring.value.coordinator);
      const result = await service.compileAndRun({
        spec: criteria.value,
        targetDir: projDir,
        dataDir: ctx.dataDir,
        snapshotInput: {
          runId,
          artifactId: `artifact-${projName}`,
          artifactHash: sha256(JSON.stringify(spec)),
          environmentSnapshotId: `env-${process.platform}-${process.arch}`,
          environmentHash: sha256(envBody),
          capabilitySnapshotId: 'cap-builtin-verifiers',
          policySnapshotId: 'policy-hooks',
          policyHash: sha256(policyBody),
        },
      }, AbortSignal.timeout(Math.min(300_000 + (spec.modules?.length ?? 0) * 120_000, 900_000)));
      if (!result.ok) throw new Error(`[${result.error.code}] ${result.error.message}`);
      const decision = result.value.decision;
      if (decision.status !== 'succeeded') {
        throw new Error(`[BUILD_DECISION_${decision.status.toUpperCase()}] ${decision.reasons.join('；') || '未通过完成判定'}`);
      }
      const modSummary = spec.modules?.length
        ? ` 模块：${plan.order.join(' → ')}（${spec.modules.length} 模块逐模块生成）`
        : ' 模具：' + spec.scaffold + '（AI 规格化）· 现代路由（BuildService 权威闭环）';
      return lines(` 构建完成「${spec.title}」 `, [
        ` ${spec.modules?.length ? '模块分解' : '模具'}：${spec.scaffold}${spec.modules?.length ? '（AI 分解 DAG）' : '（AI 规格化）'}· 现代路由（BuildService 权威闭环）`,
        ` 位置：${projDir}`,
        ` 判定：${decision.status}（owned receipt）· 验收 ${decision.criteria.map(c => c.status).join('/')}`,
        ` ${modSummary}`,
        ` 启动：cd ${projDir} && node server/index.js`,
      ]);
    }
    const { diagnoseSpec } = await import('../build/spec.js');
    const diags = diagnoseSpec(spec);
    if (dryRun) {
      const modRows = spec.modules?.length
        ? spec.modules.flatMap((m, i) => [` M${i + 1} ${m.name}${m.deps.length ? `（依赖 ${m.deps.join('/')}）` : ''}：${m.desc}`, ...m.files.map(f => `    · ${f.path} — ${f.desc}`)])
        : [];
      return lines(` 规格诊断「${spec.title}」 `, [
        ...diags.map(d => ` ${d.level === 'error' ? '✗' : d.level === 'warning' ? '!' : '·'} [${d.code}] ${d.message}`),
        ` 模具：${spec.scaffold}（AI 规格化）${spec.modules?.length ? `· 模块分解 ${spec.modules.length} 个（逐模块生成）` : '· 简单需求（模板路径）'}`,
        ` 计划：${topoSort(plan.modules).join(' → ')}（dry-run 未落盘）`,
        ...modRows,
        ` 验收：${spec.acceptance.map(a => '✓ ' + a).join('\n       ')}`,
      ]);
    }
    // 项目目录
    const projName = `p${Date.now().toString(36)}`;
    const projDir = join(ctx.dataDir, 'projects', projName);
    mkdirSync(projDir, { recursive: true });
    // 审查修复：进度流——此前 /build 全程静默（脚手架+验证+质量门 15-30s 无任何中间输出，
    // 用户不知道是卡住还是在构建）；每阶段经 system.notice 实时汇报（TUI 显示为状态行）
    const progress = (stage: string) => {
      try { ctx.bus.emit('system.notice', { text: `⛏ /build「${spec.title}」：${stage}` }); } catch { /* 静默 */ }
    };
    // 构建（脚手架 → 真实验证 → 证据落盘 → 质量门）
    progress('脚手架生成…');
    const sc = instantiate(spec, projDir, plan); // KF-022：scaffold 由 BuildPlan 驱动（绝不绕过计划）
    if (!sc.ok) return `脚手架失败：${sc.reason}`;
    // A21：规格 IR 版本化（spec.json 快照 + sha256——后续 build 可 diff/增量重编）
    try {
      const { createHash } = await import('node:crypto');
      const ir = { specVersion: 1, builtAt: Date.now(), spec, plan: { order: topoSort(plan.modules) } };
      const json = JSON.stringify(ir, null, 2);
      writeFileSync(join(projDir, 'spec.json'), json, 'utf8');
      writeFileSync(join(projDir, 'spec.sha256'), createHash('sha256').update(json).digest('hex'), 'utf8');
    } catch { /* IR 落盘失败不阻断构建 */ }
    // 审计修复：证据必须在验证之后落盘——先跑真实验证（启动→探活→重启→读回），
    // checks 填真实探活结果；验证失败则证据记录 failed（不伪造 'ok'）
    const { verifyProject } = await import('../build/verify.js');
    progress('验证（启动→探活→重启→读回）…');
    const vr = await verifyProject(projDir);
    const ev = writeEvidence(projDir, {
      status: vr.status,
      checks: vr.status === 'ok' ? ['scaffold', 'verify:start-probe-restart-readback'] : ['scaffold'],
      detail: vr.detail,
      port: null,
    });
    const fp = fingerprint(projDir);
    progress(`证据已落盘（${vr.status}）· 质量门五门…`);
    const gate = await runGate({ projectDir: projDir, dataDir: ctx.dataDir });
    const order = topoSort(plan.modules);
    const gateFail = gate.gates.filter(g => !g.ok);
    progress(gate.pass ? '五门质量门通过 ✓' : `质量门未过：${gateFail.map(g => g.name).join(',')}`);
    // A22 诚实交付：标题按真实验证结果——「构建完成」仅验证通过才写；
    // 失败如实报「未通过验证」（不假装 100% 完成）；P2-2 --strict：门禁未过同样标记失败
    const head =
      vr.status === 'ok' && (!strict || gate.pass)
        ? ` 构建完成「${spec.title}」 `
        : vr.status === 'failed'
          ? ` 构建未通过验证「${spec.title}」 `
          : strict && !gate.pass
            ? ` 构建未通过质量门「${spec.title}」 `  // 严格模式：验证过了但门禁未过
            : ` 构建完成（验证跳过）「${spec.title}」 `;
    return lines(head, [
      ` 模具：${spec.scaffold}（AI 规格化）· 模块：${order.join(' → ')}`,
      ` 验收：${spec.acceptance.map(a => '✓ ' + a).join('\n       ')}`,
      ` 位置：${projDir}`,
      ` 验证：${vr.status === 'ok' ? '✅ 启动→探活→重启→读回' : `⚠ ${vr.detail}`}`,
      ` 证据：${ev ? `evidence.json（${vr.status}，指纹 ${fp}）` : '失败'} · 质量门：${gate.pass ? '✅ 通过' : '⚠ ' + gateFail.map(g => g.name).join(',')}`,
      ` 启动：cd ${projDir} && node server/index.js`,
    ]);
  });


  bus.register('/img', async (args) => {
    const target = args[0];
    if (!target) return '用法：/img <图片路径或URL>（多模态分析，/vision 同义）';
    const { describeImageStatus } = await import('../kernel/vision.js');
    const settings = ctx.config.get('settings');
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    const r = await describeImageStatus(target, enc ?? null, undefined, settings);
    return r.ok ? (r.text ?? '（视觉端点返回空描述）') : `视觉分析不可用：${r.reason}`;
  });

  // 备份
  bus.register('/backup', () => {
    const dest = join(ctx.dataDir, 'backups', `backup-${Date.now().toString(36)}`);
    try {
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(ctx.dataDir)) {
        if (f === 'backups' || f === 'projects') continue;
        cpSync(join(ctx.dataDir, f), join(dest, f), { recursive: true });
      }
      return `备份完成 → ${dest}`;
    } catch (e: any) {
      return `备份失败：${e?.message}`;
    }
  });

  bus.register('/export', async (args) => {
    // --sanitize：导出前脱敏（OpenCode session export --sanitize 对齐）——
    // 密钥/令牌/凭据经 redactSecrets 打码，导出文件可安全分享/入 CI
    const sanitize = args.includes('--sanitize');
    const { redactSecrets } = await import('../kernel/redact.js');
    const redact = (s: string) => sanitize ? redactSecrets(String(s ?? '')).text : s;
    // --jsonl：完整会话导出（审计友好，一行一条消息——对齐 trace/rollout 格式）
    if (args[0] === '--jsonl') {
      const sid = args.find(a => !a.startsWith('--')) ?? ctx.agent?.getSessionId?.() ?? 'default';
      const rows = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? ORDER BY id`).all(sid) as any[];
      if (!rows.length) return '该会话无消息';
      const out = join(ctx.dataDir, `session-${sid.replace(/[^\w-]/g, '').slice(0, 10)}-${Date.now().toString(36)}.jsonl`);
      writeFileSync(out, rows.map(r => JSON.stringify({ ...r, content: redact(r.content), session_id: sid })).join('\n') + '\n', 'utf8');
      return `已导出会话 ${sid} 的 ${rows.length} 条消息（JSONL${sanitize ? '，已脱敏' : ''}）→ ${out}`;
    }
    const q = args.filter(a => a !== '--sanitize').join(' ');
    if (!q) return '用法：/export <关键词> [--sanitize]（导出匹配的历史消息） ｜ /export --jsonl [会话ID] [--sanitize]（完整会话导出，脱敏可分享）';
    const hits = searchMessages(ctx.db, q, { limit: 50 });
    if (!hits.length) return '无匹配';
    const out = join(ctx.dataDir, `export-${Date.now().toString(36)}.json`);
    writeFileSync(out, JSON.stringify(hits.map(h => ({ ...h, content: redact(h.content) })), null, 2), 'utf8');
    return `已导出 ${hits.length} 条${sanitize ? '（已脱敏）' : ''} → ${out}`;
  });
}
