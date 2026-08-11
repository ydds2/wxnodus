// src/commands/handlers.ts — L6-2 核心命令处理器（注册到 CommandBus）
// 设计：每个命令访问 kernel 上下文（config/db/mem/agent/bus）；输出字符串经消息流呈现
import type { Config } from '../store/config.js';
import type { Db } from '../store/db.js';
import type { Memory } from '../kernel/memory.js';
import type { EventBus } from '../kernel/events.js';
import type { CommandBus } from '../app/CommandBus.js';
import { SLASH, COMMAND_CAT, COMMAND_DESC, resolveAlias } from './registry.js';
import { capabilityBadges, decryptKey, encryptKey, filterModels, maskKey, MODEL_CATALOG } from '../kernel/providers.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { hooksFromConfig, HOOK_EVENTS } from '../kernel/hooks.js';
import { makeSpec } from '../build/spec.js';
import { makePlan, topoSort } from '../build/plan.js';
import { instantiate, checkLeftover } from '../build/scaffold.js';
import { writeEvidence, fingerprint } from '../build/evidence.js';
import { verifyProject } from '../build/verify.js';
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
  /** agent 实例（/delegate 派生子代理等） */
  agent?: { run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; spawnSubagent(goal: string): Promise<{ ok: boolean; output: string; turns: number }>; abort(): void; setMode(m: string): void; getMode(): string; setSessionId(id: string): void; getSessionId?(): string; updateTools?(extra: Record<string, any>): void; setScriptRecorder?(fn: ((name: string, args: Record<string, any>) => void) | null): void; runScript?(steps: any[]): Promise<{ ok: boolean; log: Array<{ kind: string; step: number; text: string; name?: string }> }> };
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
  gateway?: { requestCredentialForm(fields: Array<{ name: string; label?: string; kind: string }>, prompt?: string): Promise<Record<string, string> | null> } | null;
  /** 敏感数据内存保险库（/security 关闭通道时同步清空） */
  secrets?: import('../kernel/secrets.js').SecretVault;
}

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

export function registerCoreHandlers(bus: CommandBus, ctx: HandlerCtx): void {
  // 对话
  bus.register('/help', (args) => {
    if (args[0]) {
      const cmd = resolveAlias('/' + args[0].replace(/^\//, ''));
      return `${cmd}：${COMMAND_DESC[cmd] ?? '无描述'}`;
    }
    const cats = new Map<string, string[]>();
    for (const c of SLASH) {
      const cat = COMMAND_CAT[c] ?? '·';
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(c);
    }
    return lines(' 命令 ', [...cats.entries()].map(([cat, cmds]) => ` ${cat} ${cmds.slice(0, 12).join(' ')}${cmds.length > 12 ? ' …' : ''}`));
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
      return ` ${r.id}  ${r.title || '(无标题)'}（${r.msgs} 条）${t}`;
    }));
  });

  bus.register('/quit', async () => { ctx.requestExit(); return '再见'; });

  bus.register('/status', () => {
    const u = { model: ctx.getModel(), mode: ctx.getMode(), cwd: ctx.cwd };
    const sec = ((ctx.config.get('settings') as any)?.security ?? {}) as Record<string, boolean>;
    const autoReview = (ctx.config.get('settings') as any)?.autoReview === true;
    return lines(' 状态 ', [
      ` 模型：${u.model || '未配置（/key set <密钥> 配置）'}`,
      ` 模式：${u.mode}`,
      ` 目录：${u.cwd}`,
      ` 命令：${SLASH.length} 个`,
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
    return lines(' 体检 ', checks.map(([k, v]) => ` ${k}：${v}`));
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
    if (!enc) return '密钥状态：未配置——/key set <密钥> 配置后获得完整能力';
    // 验证可解密：enc 存在但机器指纹变化（hostname/用户名）会导致解密失败
    const dec = decryptKey(enc);
    return dec
      ? `密钥状态：已配置（${maskKey(dec)}）`
      : '密钥状态：已配置但无法解密（机器环境变化或数据损坏？）——请 /key set <密钥> 重新配置';
  });

  bus.register('/version', () => 'WxNodus 3.0.0 · 概念进·证据出');

  // 模式（Claude Code 五模式体系：smart 更改前确认 / auto 自动编辑 / goal loop-goal /
  // manual 全量确认 / plan 计划模式 / yolo 完全访问）
  bus.register('/perm', (args) => {
    const mode = args[0];
    if (mode && ['smart', 'auto', 'manual', 'plan', 'yolo', 'goal'].includes(mode)) {
      ctx.setMode(mode);
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

  // 黑洞检索（FTS + 向量语义融合：/hole 上次怎么解决的 也能命中）
  bus.register('/hole', async (args) => {
    const q = args.join(' ');
    if (!q) return '用法：/hole <关键词>（自然语言「搜一下…」亦可直达）';
    const hits = await ctx.mem.recallHybrid(q, { limit: 5 });
    if (!hits.length) return `黑洞检索「${q}」：无命中`;
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    return lines(` 黑洞检索「${q}」 `, hits.map(h => {
      const fromOther = Boolean(h.session_id) && h.session_id !== sid;
      return ` [${fromOther ? `会话 ${h.session_id!.slice(0, 10)}` : '当前'}] ${h.content.slice(0, 70)}${fromOther ? `（/resume ${h.session_id} 跳转）` : ''}`;
    }));
  });

  bus.register('/memory', (args) => {
    const rec = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default');
    const absorbed = ctx.mem.absorbCount('default');
    const sub = args[0];

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
      const rows = ctx.db.prepare(
        `SELECT id, role, content, salience FROM messages WHERE archived=0 ORDER BY id DESC LIMIT ?`
      ).all(n) as Array<{ id: number; role: string; content: string; salience: number }>;
      return lines(' 记忆消息（/memory pin|fade <id> 加权） ', rows.reverse().map(m => {
        const flag = m.salience > 1.01 ? '★' : m.salience < 0.99 ? '☆' : ' ';
        return ` ${flag} #${m.id} [${m.role}] ${String(m.content).slice(0, 60)}${m.salience > 1.01 ? `（×${m.salience}）` : ''}`;
      }));
    }

    const salient = ctx.mem.listSalient();
    return lines(' 记忆 ', [
      ` 全量消息：${rec.length} 条`,
      ` 已吸附归档：${absorbed} 条（黑洞引擎）`,
      ` 窗口：${Math.min(rec.length, 20)}/20`,
      ...(salient.length
        ? [` 置顶记忆：${salient.length} 条（召回加权优先）`,
           ...salient.slice(0, 8).map(s => `   ★ #${s.id} ×${s.salience} ${s.content.slice(0, 40)}`)]
        : [` 置顶记忆：无（/memory pin <id> 可把核心约束置顶，召回恒优先）`]),
    ]);
  });

  // 概念编译（超复杂项目能力）
  bus.register('/build', async (args) => {
    const input = args.join(' ');
    if (!input) return '用法：/build <需求>（自然语言「做个待办系统」亦可直达）';
    const spec = makeSpec(input, { key: ctx.getModel() ? 'x' : null });
    if (spec.scaffold === 'unknown') return `需求无法编译（${input.slice(0, 30)}…）——换个说法或说「/help build」`;
    const plan = makePlan(input, { key: null });
    // 项目目录
    const projName = `p${Date.now().toString(36)}`;
    const projDir = join(ctx.dataDir, 'projects', projName);
    mkdirSync(projDir, { recursive: true });
    // 构建（脚手架 → 真实验证 → 证据落盘 → 质量门）
    const sc = instantiate(spec, projDir);
    if (!sc.ok) return `脚手架失败：${sc.reason}`;
    // 审计修复：证据必须在验证之后落盘——先跑真实验证（启动→探活→重启→读回），
    // checks 填真实探活结果；验证失败则证据记录 failed（不伪造 'ok'）
    const { verifyProject } = await import('../build/verify.js');
    const vr = await verifyProject(projDir);
    const ev = writeEvidence(projDir, {
      status: vr.status,
      checks: vr.status === 'ok' ? ['scaffold', 'verify:start-probe-restart-readback'] : ['scaffold'],
      detail: vr.detail,
      port: null,
    });
    const fp = fingerprint(projDir);
    const gate = await runGate({ projectDir: projDir, dataDir: ctx.dataDir });
    const order = topoSort(plan.modules);
    const gateFail = gate.gates.filter(g => !g.ok);
    return lines(` 构建完成「${spec.title}」 `, [
      ` 模具：${spec.scaffold} · 模块：${order.join(' → ')}`,
      ` 验收：${spec.acceptance.map(a => '✓ ' + a).join('\n       ')}`,
      ` 位置：${projDir}`,
      ` 验证：${vr.status === 'ok' ? '✅ 启动→探活→重启→读回' : `⚠ ${vr.detail}`}`,
      ` 证据：${ev ? `evidence.json（${vr.status}，指纹 ${fp}）` : '失败'} · 质量门：${gate.pass ? '✅ 通过' : '⚠ ' + gateFail.map(g => g.name).join(',')}`,
      ` 启动：cd ${projDir} && node server/index.js`,
    ]);
  });

  // 视觉（GLM-4V）
  bus.register('/vision', async (args) => {
    const target = args[0];
    if (!target) return '用法：/vision <图片路径或URL>（GLM-4V 多模态分析）';
    const { describeImage } = await import('../kernel/vision.js');
    const key = ctx.config.getKey('settings', 'apiKeyEnc');
    const out = await describeImage(target, key ? ctx.config.getKey('settings', 'apiKeyEnc') : null);
    return out ?? '视觉分析失败（需配置 GLM key：/key set <key>，或网络不可达）';
  });

  bus.register('/img', async (args) => {
    const target = args[0];
    if (!target) return '用法：/img <图片路径或URL>（GLM-4V 多模态分析，/vision 同义）';
    const { describeImage } = await import('../kernel/vision.js');
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    const out = await describeImage(target, enc ?? null);
    return out ?? '视觉分析失败（需配置 GLM key：/key set <key>，或网络不可达）';
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
    // --jsonl：完整会话导出（审计友好，一行一条消息——对齐 trace/rollout 格式）
    if (args[0] === '--jsonl') {
      const sid = args[1] ?? ctx.agent?.getSessionId?.() ?? 'default';
      const rows = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? ORDER BY id`).all(sid) as any[];
      if (!rows.length) return '该会话无消息';
      const out = join(ctx.dataDir, `session-${sid.replace(/[^\w-]/g, '').slice(0, 10)}-${Date.now().toString(36)}.jsonl`);
      writeFileSync(out, rows.map(r => JSON.stringify({ ...r, session_id: sid })).join('\n') + '\n', 'utf8');
      return `已导出会话 ${sid} 的 ${rows.length} 条消息（JSONL）→ ${out}`;
    }
    const q = args.join(' ');
    if (!q) return '用法：/export <关键词>（导出匹配的历史消息） ｜ /export --jsonl [会话ID]（完整会话导出）';
    const hits = searchMessages(ctx.db, q, { limit: 50 });
    if (!hits.length) return '无匹配';
    const out = join(ctx.dataDir, `export-${Date.now().toString(36)}.json`);
    writeFileSync(out, JSON.stringify(hits, null, 2), 'utf8');
    return `已导出 ${hits.length} 条 → ${out}`;
  });
}
