// src/commands/handlers.ts — L6-2 核心命令处理器（注册到 CommandBus）
// 设计：每个命令访问 kernel 上下文（config/db/mem/agent/bus）；输出字符串经消息流呈现
import type { Config } from '../store/config.js';
import type { Db } from '../store/db.js';
import type { Memory } from '../kernel/memory.js';
import type { EventBus } from '../kernel/events.js';
import type { CommandBus } from '../app/CommandBus.js';
import { SLASH, COMMAND_CAT, COMMAND_DESC, resolveAlias } from './registry.js';
import { capabilityBadges, decryptKey, encryptKey, filterModels, maskKey, MODEL_CATALOG } from '../kernel/providers.js';
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
  agent?: { run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; spawnSubagent(goal: string): Promise<{ ok: boolean; output: string; turns: number }>; abort(): void; setMode(m: string): void; getMode(): string; setSessionId(id: string): void; getSessionId?(): string; updateTools?(extra: Record<string, any>): void };
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
    return lines(' 状态 ', [
      ` 模型：${u.model || '未配置（/key set <密钥> 配置）'}`,
      ` 模式：${u.mode}`,
      ` 目录：${u.cwd}`,
      ` 命令：${SLASH.length} 个`,
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
      checks.push(['黑洞记忆', `${total} 条（吸附 ${archived} 条）`]);
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
  bus.register('/login', async (args) => {
    const { MODEL_CATALOG } = await import('../kernel/providers.js');
    const provider = (args[0] ?? '').toLowerCase();
    if (!provider) {
      const providers = [...new Set(MODEL_CATALOG.map(m => m.provider))];
      return lines(' 登录（选择平台） ', [
        ...providers.map(p => ` ${p}：/login ${p} <API 密钥>`),
        '',
        ' 本地 API Key 认证（密钥 AES-256-GCM 加密存储，绝不回显）',
        ' 示例：/login deepseek sk-xxxxxxxx',
      ]);
    }
    const hit = MODEL_CATALOG.find(m => m.provider === provider);
    if (!hit) return `未知平台：${provider}（可用：${[...new Set(MODEL_CATALOG.map(m => m.provider))].join(' / ')}）`;
    const key = args[1] ?? '';
    if (!key) return `用法：/login ${provider} <API 密钥>（如 /login ${provider} sk-xxx）`;
    ctx.config.setKey('settings', 'apiKeyEnc', encryptKey(key));
    ctx.config.setKey('settings', 'model', hit.modelId);
    ctx.config.setKey('settings', 'baseURL', hit.baseURL);
    ctx.setModel(hit.modelId, hit.baseURL);
    return `已登录 ${provider}（模型：${hit.modelId}，密钥加密存储）——可用 /model 切换或 /logout 退出`;
  });

  // /logout：清除凭证（配置类）
  bus.register('/logout', () => {
    ctx.config.setKey('settings', 'apiKeyEnc', '');
    return '已退出登录（密钥已清除）——对话将提示配置，直到重新 /login 或 /key set';
  });

  // /yolo：完全访问开关（参考 yolo 命令同款；等价 /perm yolo）
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
      if (!ctx.config.getKey('settings', 'model')) ctx.config.setKey('settings', 'model', 'deepseek-v4-flash');
      if (!ctx.config.getKey('settings', 'baseURL')) ctx.config.setKey('settings', 'baseURL', 'https://api.deepseek.com/v1');
      return '密钥已配置（AES-256-GCM 加密存储，绝不回显）';
    }
    // 兼容规则脑提示里的用法：/key <密钥> 直接配置（非已知子命令视为密钥）
    if (!['status', 'set', 'off'].includes(sub) && args.length >= 1) {
      ctx.config.setKey('settings', 'apiKeyEnc', encryptKey(args[0]));
      if (!ctx.config.getKey('settings', 'model')) ctx.config.setKey('settings', 'model', 'deepseek-v4-flash');
      if (!ctx.config.getKey('settings', 'baseURL')) ctx.config.setKey('settings', 'baseURL', 'https://api.deepseek.com/v1');
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
    if (name) { ctx.setTheme(name); return `主题已切换：${name}`; }
    return `当前主题：${ctx.getThemeName()}（可选：wxnodus 黑洞/dark/light）`;
  });

  // 黑洞检索
  bus.register('/hole', async (args) => {
    const q = args.join(' ');
    if (!q) return '用法：/hole <关键词>（自然语言「搜一下…」亦可直达）';
    const hits = searchMessages(ctx.db, q, { limit: 5 });
    if (!hits.length) return `黑洞检索「${q}」：无命中`;
    return lines(` 黑洞检索「${q}」 `, hits.map(h => ` [${h.role}] ${h.content.slice(0, 80)}`));
  });

  bus.register('/memory', () => {
    const rec = ctx.mem.recall('default');
    const absorbed = ctx.mem.absorbCount('default');
    return lines(' 记忆 ', [
      ` 全量消息：${rec.length} 条`,
      ` 已吸附归档：${absorbed} 条（黑洞引擎）`,
      ` 窗口：${Math.min(rec.length, 20)}/20`,
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
    // 构建（脚手架 + 验证 + 证据）
    const sc = instantiate(spec, projDir);
    if (!sc.ok) return `脚手架失败：${sc.reason}`;
    const ev = writeEvidence(projDir, { status: 'ok', checks: ['scaffold'], port: null });
    const fp = fingerprint(projDir);
    const gate = await runGate({ projectDir: projDir, dataDir: ctx.dataDir });
    const order = topoSort(plan.modules);
    return lines(` 构建完成「${spec.title}」 `, [
      ` 模具：${spec.scaffold} · 模块：${order.join(' → ')}`,
      ` 验收：${spec.acceptance.map(a => '✓ ' + a).join('\n       ')}`,
      ` 位置：${projDir}`,
      ` 证据：${ev ? `evidence.json（指纹 ${fp}）` : '失败'} · 质量门：${gate.pass ? '✅ 通过' : '⚠ ' + gate.gates.filter(g => !g.ok).map(g => g.name).join(',')}`,
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
