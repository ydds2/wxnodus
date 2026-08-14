// src/commands/handlers.ts — L6-2 核心命令处理器（注册到 CommandBus）
// 设计：每个命令访问 kernel 上下文（config/db/mem/agent/bus）；输出字符串经消息流呈现
import type { Config } from '../store/config.js';
import type { Db } from '../store/db.js';
import type { Memory } from '../kernel/memory.js';
import { parseSinceArg } from '../kernel/memory.js';
import { deleteMessage, updateMessage, appendAudit } from '../store/db.js';
import type { EventBus } from '../kernel/events.js';
import type { CommandBus } from '../app/CommandBus.js';
import { SLASH, COMMAND_CAT, COMMAND_DESC, COMMAND_MERGE, resolveAlias } from './registry.js';
import { capabilityBadges, decryptKey, encryptKey, filterModels, maskKey, MODEL_CATALOG } from '../kernel/providers.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { hooksFromConfig, HOOK_EVENTS } from '../kernel/hooks.js';
import { makeSpec } from '../build/spec.js';
import { makePlan, topoSort } from '../build/plan.js';
import { instantiate } from '../build/scaffold.js';
import { writeEvidence, fingerprint } from '../build/evidence.js';
import { runGate } from '../build/gate.js';
import { searchMessages } from '../store/db.js';
import { join } from 'node:path';
import { mkdirSync, existsSync, readdirSync, cpSync, writeFileSync } from 'node:fs';

export interface HandlerCtx {
  dataDir: string;
  cwd: string;
  db: Db;
  mem: Memory;
  config: Config;
  bus: EventBus;
  /** agent 实例（/delegate 派生子代理等）；P0-2：第三参数传自定义 agent 定义 */
  agent?: { run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; spawnSubagent(goal: string, depth?: number, def?: { systemPromptOverride?: string; mode?: string; tools?: string[] }): Promise<{ ok: boolean; output: string; turns: number }>; abort(): void; setMode(m: string): void; getMode(): string; setSessionId(id: string): void; getSessionId?(): string; updateTools?(extra: Record<string, any>): void; setScriptRecorder?(fn: ((name: string, args: Record<string, any>) => void) | null): void; runScript?(steps: any[]): Promise<{ ok: boolean; log: Array<{ kind: string; step: number; text: string; name?: string }> }> };
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
}

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

// TTY 门控 ANSI 着色（面板级样式）：TUI 交互输出彩色（slash 消息已支持 Ansi 渲染），
// -p 管道/测试环境 stdout 非 TTY → 纯文本（脚本与断言零污染）
export const c = (s: string, code: string): string => (process.stdout.isTTY === true ? `\x1b[${code}m${s}\x1b[0m` : s);

export function registerCoreHandlers(bus: CommandBus, ctx: HandlerCtx): void {
  // 对话
  bus.register('/help', (args) => {
    if (args[0]) {
      const cmd = resolveAlias('/' + args[0].replace(/^\//, ''));
      const merge = COMMAND_MERGE[cmd];
      // 审查修复：UI 本地命令（/details /copy /voice 等）不在内核注册表——此前返回
      // 误导性「无描述」；改为明确提示 TUI 本地命令
      if (!COMMAND_DESC[cmd] && !SLASH.includes(cmd)) {
        return `${cmd}：TUI 本地命令（麦克风钮/Ctrl+K/? 面板等处可用）——/help 全目录不含 UI 层命令`;
      }
      return `${cmd}：${COMMAND_DESC[cmd] ?? '无描述'}${merge ? `（已并入 ${merge}）` : ''}`;
    }
    // 100% 重构：分组标题行 + 每命令一行两列（命令名 / 描述）——TTY 门控 ANSI 彩色，
    // TUI 彩色（slash 消息已支持 Ansi 渲染）、-p 管道/测试纯文本
    const catName: Record<string, string> = {
      '◈': '对话', '⚙': '模型', '▤': '记忆', '◆': '构建', '⛨': '安全', '◉': '系统',
      '❖': '视觉', '⚿': '输入', '⛭': '网络', '◍': '协作', '☆': '工具', '⬡': '上下文',
      '⬇': '离线',
    };
    const cats = new Map<string, string[]>();
    for (const cmd of SLASH) {
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
    rows.push('', `${c(' ◈ 提示', '1;33')}：/help <命令> 查看单个命令详情 · /map 生成仓库地图`);
    return lines(` 命令（共 ${SLASH.length} 个） `, rows);
  });

  bus.register('/clear', async () => { ctx.clearHistory(); return '已清空'; });

  // 会话（交互模式打开选择器；-p 模式文本列表；P2b：支持标题/ID 关键词过滤）
  bus.register('/sessions', (args) => {
    const rows = ctx.db.prepare(`SELECT s.id, s.title, s.created_at, s.updated_at, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msgs FROM sessions s ORDER BY s.updated_at DESC`).all() as any[];
    if (!rows.length) return '暂无会话';
    const q = args.join(' ').trim().toLowerCase();
    const filtered = q ? rows.filter(r => (String(r.title ?? '') + ' ' + r.id).toLowerCase().includes(q)) : rows;
    if (!filtered.length) return `无匹配会话：${q}`;
    if (process.stdout.isTTY) {
      ctx.openSessions();
      return '';
    }
    // 非交互模式：文本列表（按最近更新排序）
    return lines(' 会话 ', filtered.map(r => {
      const t = new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false });
      return ` ${c(r.id, '35')}  ${r.title || '(无标题)'}（${r.msgs} 条）${t}`;
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
    const sec = ((ctx.config.get('settings') as any)?.security ?? {}) as Record<string, boolean>;
    const autoReview = (ctx.config.get('settings') as any)?.autoReview === true;
    return lines(' 状态 ', [
      ` 模型：${c(u.model || '未配置（/key set <密钥> 配置）', u.model ? '35' : '33')}`,
      ` 模式：${c(u.mode, '36')}`,
      ` 目录：${c(u.cwd, '36')}`,
      ` 命令：${c(`${SLASH.length} 个`, '36')}`,
      ` 智能：${[
        autoReview ? 'AI 预审' : null,
        sec.sudoInjection ? 'sudo 通道' : null,
        sec.secretInjection ? 'secret 通道' : null,
        (ctx.config.get('settings') as any)?.lowRiskAutoApprove !== false ? '低危放行' : null,
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
    // 密钥真实解密验证（加密 ≠ 可用——机器指纹变化会解密失败）
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    if (enc) {
      const dec = decryptKey(enc);
      checks.push(['模型密钥', dec ? '已配置且可解密' : '已配置但无法解密（需 /key set 重配）']);
    } else {
      checks.push(['模型密钥', '未配置（/key set <密钥> 配置）']);
    }
    // 当前模型目录可用性
    const model = ctx.getModel();
    checks.push(['当前模型', model ? model : '未选择']);
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

  // 密钥
  bus.register('/key', async (args) => {
    const sub = args[0] ?? 'status';
    if (sub === 'set' && args[1]) {
      ctx.config.setKey('settings', 'apiKeyEnc', encryptKey(args[1]));
      // 补默认模型/端点：有 key 但 model/baseURL 缺失时 agent 会降级规则脑
      // （提示「未配置」）——配置密钥即视为已配置，补齐默认并持久化
      if (!ctx.config.getKey('settings', 'model')) ctx.config.setKey('settings', 'model', resolveDefaultModel({}));
      if (!ctx.config.getKey('settings', 'baseURL')) ctx.config.setKey('settings', 'baseURL', resolveDefaultBaseURL({}));
      return '密钥已配置（AES-256-GCM 加密存储，绝不回显）';
    }
    // 兼容规则脑提示里的用法：/key <密钥> 直接配置（非已知子命令视为密钥）
    if (!['status', 'set', 'off'].includes(sub) && args.length >= 1) {
      ctx.config.setKey('settings', 'apiKeyEnc', encryptKey(args[0]));
      if (!ctx.config.getKey('settings', 'model')) ctx.config.setKey('settings', 'model', resolveDefaultModel({}));
      if (!ctx.config.getKey('settings', 'baseURL')) ctx.config.setKey('settings', 'baseURL', resolveDefaultBaseURL({}));
      return '密钥已配置（AES-256-GCM 加密存储，绝不回显）';
    }
    if (sub === 'off') {
      ctx.config.setKey('settings', 'apiKeyEnc', '');
      return '密钥已清除（对话将提示配置，直到重新 /key set）';
    }
    const enc = ctx.config.getKey('settings', 'apiKeyEnc');
    if (!enc) return `密钥状态：${c('未配置', '33')}——/key set <密钥> 配置后获得完整能力`;
    // 验证可解密：enc 存在但机器指纹变化（hostname/用户名）会导致解密失败
    const dec = decryptKey(enc);
    return dec
      ? `密钥状态：${c('已配置', '32')}（${maskKey(dec)}）`
      : `密钥状态：${c('已配置但无法解密', '31')}（机器环境变化或数据损坏？）——请 /key set <密钥> 重新配置`;
  });

  bus.register('/version', () => 'WxNodus 3.0.0 · 概念进·证据出');

  // 模式（Claude Code 五模式体系：smart 更改前确认 / auto 自动编辑 / goal loop-goal /
  // manual 全量确认 / plan 计划模式 / yolo 完全访问）
  bus.register('/perm', (args) => {
    const mode = args[0];
    if (mode && ['smart', 'auto', 'manual', 'plan', 'yolo', 'goal'].includes(mode)) {
      const from = ctx.getMode();
      ctx.setMode(mode);
      // A21：模式切换落审计（哈希链）
      try { appendAudit(ctx.db, 'mode.changed', { from, to: mode, source: 'cmd' }); } catch { /* 审计表未就绪静默 */ }
      return `模式已切换：${mode}`;
    }
    return '当前模式：' + ctx.getMode() + '（可选：smart 更改前确认 / auto 自动编辑 / goal loop-goal / manual 全量确认 / plan 计划模式 / yolo 完全访问）';
  });

  // 模型选择（无参 → 打开交互选择器；有参 → 模糊过滤+目录查找直接切换）
  bus.register('/model', (args) => {
    const q = args.join(' ');
    if (q) {
      // UI 模型选择器传入的是命令串（"modelId --provider slug [--global|--session]"），
      // 取第一个 token 作为 modelId（modelId 不含空格）
      const clean = q.split(/\s+/)[0] ?? q;
      const s = clean.toLowerCase();
      const hit = MODEL_CATALOG.find(m => m.name.toLowerCase() === s || m.modelId.toLowerCase() === s);
      if (!hit) {
        const filtered = filterModels(q);
        const list = filtered.length ? filtered : MODEL_CATALOG;
        return lines(' 模型目录 ', [`未找到「${q}」${filtered.length ? '，相近模型：' : '，可用模型：'}`, ...list.map(m => ` ${m.name}（${m.provider}）${capabilityBadges(m.capabilities)}`)]);
      }
      ctx.setModel(hit.modelId, hit.baseURL);
      return `已切换模型：${hit.name}（${hit.provider}）${capabilityBadges(hit.capabilities)}`;
    }
    ctx.openModelPicker();
    return '';
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
      ctx.setTheme(name);
      // 开放兼容：广播 theme.changed——UI 监听真实切换（dark/light/wxnodus）
      ctx.bus.emit('theme.changed', { name });
      return `主题已切换：${name}`;
    }
    return `当前主题：${ctx.getThemeName()}（可选：wxnodus 黑洞/dark/light）`;
  });

  bus.register('/memory', async (args) => {
    const rec = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default');
    const absorbed = ctx.mem.absorbCount('default');
    const sub = args[0];

    // A21：检索（混合召回 + 时间过滤）——/memory search <词> [--limit N] [--since X]
    if (sub === 'search') {
      // 查询词剔除 flags 及其值（--limit/--since）
      const q = args
        .slice(1)
        .filter((a, i, arr) => {
          if (a.startsWith('--')) return false;
          const prev = arr[i - 1];
          return prev !== '--limit' && prev !== '--since';
        })
        .join(' ')
        .trim();
      if (!q) return '用法：/memory search <关键词> [--limit N] [--since 7d|2026-08-01]';
      const limit = (() => {
        const i = args.indexOf('--limit');
        const n = Number(args[i + 1]);
        return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 10;
      })();
      const sinceIdx = args.indexOf('--since');
      const since = parseSinceArg(sinceIdx >= 0 ? args[sinceIdx + 1] : undefined) ?? undefined;
      const hits = await ctx.mem.recallHybrid(q, { limit, since });
      if (!hits.length) return `未检索到与「${q}」相关的记忆`;
      return lines(` 记忆检索「${q}」(${hits.length} 条) `, hits.map(h => {
        const when = new Date(h.ts ?? Date.now()).toLocaleString();
        return ` #${h.id} ${h.content.slice(0, 70)}${h.session_id && h.session_id !== 'default' ? ` [${h.session_id.slice(0, 10)}]` : ''}（${when}）`;
      }));
    }

    // A21：删除（物理删除 + 向量索引同步清）——/memory delete <id>
    if (sub === 'delete') {
      const id = Number(args[1]);
      if (!Number.isInteger(id) || id < 1) return '用法：/memory delete <消息id>（id 见 /memory list）';
      const ok = deleteMessage(ctx.db, id);
      if (!ok) return `消息 #${id} 不存在`;
      return `已删除消息 #${id}（FTS/向量索引同步清理）`;
    }

    // P0-2：改写（记忆纠错/更新——FTS 同步 + 旧向量清除）——/memory update <id> <新内容>
    if (sub === 'update') {
      const id = Number(args[1]);
      const content = args.slice(2).join(' ').trim();
      if (!Number.isInteger(id) || id < 1 || !content) return '用法：/memory update <消息id> <新内容>（id 见 /memory list）';
      const ok = updateMessage(ctx.db, id, content);
      if (!ok) return `消息 #${id} 不存在`;
      return `已更新消息 #${id}（FTS 同步，旧向量已清除）`;
    }

    // 置顶/淡化（salience 加权召回）：/memory pin|fade|reset <id> [倍率]
    if (sub === 'pin' || sub === 'fade' || sub === 'reset') {
      const id = Number(args[1]);
      if (!Number.isInteger(id) || id < 1) {
        return '用法：/memory pin|fade|reset <消息id> [倍率]（id 见 /memory list；/hole 检索结果亦可定位）';
      }
      const mult = sub === 'reset' ? 1 : Number(args[2] ?? (sub === 'pin' ? 3 : 0.3));
      if (!Number.isFinite(mult) || mult <= 0) return '倍率需为正数（pin 建议 3，fade 建议 0.3，范围 0.05-10）';
      const ok = ctx.mem.setSalience(id, mult);
      if (!ok) return `消息 #${id} 不存在（/memory list 查看可用 id）`;
      const label = sub === 'pin' ? '置顶' : sub === 'fade' ? '淡化' : '还原';
      return `已${label}消息 #${id}（salience ×${mult}，召回加权生效）——/memory list 查看置顶项`;
    }

    if (sub === 'list') {
      const n = Math.min(Number(args[1] ?? 10) || 10, 30);
      // A21：--since 时间过滤
      const sinceIdx = args.indexOf('--since');
      const since = parseSinceArg(sinceIdx >= 0 ? args[sinceIdx + 1] : undefined);
      const rows = ctx.db.prepare(
        `SELECT id, role, content, salience FROM messages WHERE archived=0 ${since ? `AND ts >= ${Math.floor(since)}` : ''} ORDER BY id DESC LIMIT ?`
      ).all(n) as Array<{ id: number; role: string; content: string; salience: number }>;
      return lines(' 记忆消息（/memory pin|fade <id> 加权） ', rows.reverse().map(m => {
        const flag = m.salience > 1.01 ? '★' : m.salience < 0.99 ? '☆' : ' ';
        return ` ${flag} #${m.id} [${m.role}] ${String(m.content).slice(0, 60)}${m.salience > 1.01 ? `（×${m.salience}）` : ''}`;
      }));
    }

    const salient = ctx.mem.listSalient();
    return lines(' 记忆 ', [
      ` 全量消息：${c(`${rec.length} 条`, '36')}`,
      ` 已吸附归档：${c(`${absorbed} 条`, '35')}（黑洞引擎）`,
      ` 窗口：${Math.min(rec.length, 20)}/20`,
      ...(salient.length
        ? [` 置顶记忆：${c(`${salient.length} 条`, '33')}（召回加权优先）`,
           ...salient.slice(0, 8).map(s => `   ★ #${s.id} ×${s.salience} ${s.content.slice(0, 40)}`)]
        : [` 置顶记忆：无（/memory pin <id> 可把核心约束置顶，召回恒优先）`]),
    ]);
  });

  // 概念编译（超复杂项目能力）
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
    // P0-1：规格化双通道——规则脑优先（快/零 token）；未命中且有密钥 → LLM 开放域
    const settings = ctx.config.get('settings') as { apiKeyEnc?: string | null; baseURL?: string; model?: string };
    const { resolveApiKey, MODEL_CATALOG } = await import('../kernel/providers.js');
    const keyRes = resolveApiKey(settings);
    let spec = makeSpec(input, { key: keyRes.key ? 'x' : null });
    let specSource: 'ai' | 'rule' = 'rule';
    if (spec.scaffold === 'unknown' && keyRes.key) {
      // 规则脑未命中且有密钥——LLM 规格化；失败降级规则脑（unknown）并如实提示
      const { aiMakeSpec } = await import('../build/llmSpec.js');
      const model = settings.model && MODEL_CATALOG.some(m => m.modelId === settings.model)
        ? settings.model
        : resolveDefaultModel(settings);
      const ai = await aiMakeSpec(input, { baseURL: resolveDefaultBaseURL(settings), model, key: keyRes.key });
      if (ai) { spec = ai; specSource = 'ai'; }
    }
    if (spec.scaffold === 'unknown') {
      return `需求无法编译（${input.slice(0, 30)}…）——规则脑未命中${keyRes.key ? '且 AI 规格化失败（检查模型配置或重试）' : '；/key set <密钥> 后可 AI 规格化任意需求'}；或说「/help build」`;
    }
    // W3 Build facade：modern 路由走 BuildService.compileAndRun（staging→scaffold→staticEntry→verifier→evidence→reviewer→owned receipt）。
    // spec→结构化验收（规则脑确定性锚点；未知模具 fail-closed）；快照真实来源（env/capability/hooks 确定性哈希）；
    // reviewer 密钥 AES 持久化（明文绝不落盘）。
    if (buildRoute.value.route === 'modern') {
      const { createHash } = await import('node:crypto');
      const { join } = await import('node:path');
      const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
      const { specToAcceptance } = await import('../build/specAcceptance.js');
      const criteria = specToAcceptance(spec);
      if (!criteria.ok) {
        throw new Error(`[${criteria.error.code}] ${criteria.error.message}（规则脑模具 ${spec.scaffold} 无结构化验收——现代编译拒绝）`);
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
        // 原始规则脑 spec 驱动脚手架（criteria 仅验收断言）；legacy instantiate/verify 作为节点真实执行
        instantiate: (_criteria, stagingDir) => instantiate(spec, stagingDir) as never,
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
      }, AbortSignal.timeout(300_000));
      if (!result.ok) throw new Error(`[${result.error.code}] ${result.error.message}`);
      const decision = result.value.decision;
      if (decision.status !== 'succeeded') {
        throw new Error(`[BUILD_DECISION_${decision.status.toUpperCase()}] ${decision.reasons.join('；') || '未通过完成判定'}`);
      }
      return lines(` 构建完成「${spec.title}」 `, [
        ` 模具：${spec.scaffold}（${specSource === 'ai' ? 'AI 规格化' : '规则模板'}）· 现代路由（BuildService 权威闭环）`,
        ` 位置：${projDir}`,
        ` 判定：${decision.status}（owned receipt）· 验收 ${decision.criteria.map(c => c.status).join('/')}`,
        ` 启动：cd ${projDir} && node server/index.js`,
      ]);
    }
    const plan = makePlan(input, { key: null });
    const { diagnoseSpec } = await import('../build/spec.js');
    const diags = diagnoseSpec(spec);
    if (dryRun) {
      return lines(` 规格诊断「${spec.title}」 `, [
        ...diags.map(d => ` ${d.level === 'error' ? '✗' : d.level === 'warning' ? '!' : '·'} [${d.code}] ${d.message}`),
        ` 模具：${spec.scaffold}（${specSource === 'ai' ? 'AI 规格化' : '规则模板'}）`,
        ` 计划：${topoSort(plan.modules).join(' → ')}（dry-run 未落盘）`,
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
    const sc = instantiate(spec, projDir);
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
      ` 模具：${spec.scaffold}（${specSource === 'ai' ? 'AI 规格化' : '规则模板'}）· 模块：${order.join(' → ')}`,
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
