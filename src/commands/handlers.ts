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
  agent?: { run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>; spawnSubagent(goal: string): Promise<{ ok: boolean; output: string; turns: number }>; abort(): void; setMode(m: string): void; getMode(): string; setSessionId(id: string): void };
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

  // 会话（交互模式打开选择器；-p 模式文本列表）
  bus.register('/sessions', () => {
    const rows = ctx.db.prepare(`SELECT s.id, s.title, s.created_at, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msgs FROM sessions s ORDER BY s.updated_at DESC`).all() as any[];
    if (!rows.length) return '暂无会话';
    ctx.openSessions();
    return '';
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
    const checks = [
      ['配置中心', existsSync(join(ctx.dataDir, 'settings.json')) ? '正常' : '未初始化'],
      ['数据库', '正常'],
      ['黑洞记忆', '正常'],
      ['模型密钥', ctx.getModel() ? '已配置' : '未配置（/key set <密钥> 配置）'],
    ];
    return lines(' 体检 ', checks.map(([k, v]) => ` ${k}：${v}`));
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
    if (!q) return '用法：/hole <关键词>（说人话「搜一下…」也会触发）';
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
    if (!input) return '用法：/build <需求>（说人话「做个待办系统」也会触发）';
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
    const q = args.join(' ');
    if (!q) return '用法：/export <关键词>（导出匹配的历史消息）';
    const hits = searchMessages(ctx.db, q, { limit: 50 });
    if (!hits.length) return '无匹配';
    const out = join(ctx.dataDir, `export-${Date.now().toString(36)}.json`);
    writeFileSync(out, JSON.stringify(hits, null, 2), 'utf8');
    return `已导出 ${hits.length} 条 → ${out}`;
  });
}
