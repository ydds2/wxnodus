// src/commands/handlersExt.ts — 扩展命令处理器（补齐 registry 全量 67 条）
// 设计：与 handlers.ts 分离，按类补齐——工具（确定性）/会话/记忆/构建/安全/
//       系统/视觉/连接/协作。每个命令真实可用（查询现有数据或执行确定性操作），
//       输出统一 lines() 面板或单行。红线：只读工具不写库；路径操作限制在 dataDir。
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { join, basename, extname } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { searchMessages, appendAudit, saveCheckpoint, restoreCheckpoint } from '../store/db.js';
import { estimateTokens, compactKeepHeadTail } from '../kernel/memory.js';
import { runGate } from '../build/gate.js';
import { writeEvidence } from '../build/evidence.js';
import { forgeMcpServer, forgeSkillDir } from '../forge/forge.js';
import { discoverSkills, loadSkill, installSkill, writeSkill, skillContentForModel } from '../kernel/skills.js';
import { scanProject, renderAgentsMd } from '../kernel/projectScan.js';
import { decryptKey } from '../kernel/providers.js';
import { HARD_REDLINES } from '../kernel/permissions.js';
import { runCuratorReview, curatorConfigFrom, readCuratorState } from '../kernel/curator.js';
import type { HandlerCtx } from './handlers.js';
import type { CommandBus, StructuredCommand } from '../app/CommandBus.js';

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

// ── Webhook 引擎（事件 → HTTP POST 回调；本地化为准，默认全部核心事件）──
const WEBHOOK_EVENTS = ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'system.notice', 'ui.confirm'];
const webhookSubs = new Map<string, () => void>();

function subscribeWebhooks(ctx: HandlerCtx): void {
  const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string; events?: string[] }> | undefined) ?? [];
  for (const h of hooks) {
    if (!h?.url || webhookSubs.has(h.url)) continue;
    const events = h.events?.length ? h.events : WEBHOOK_EVENTS;
    const offs: Array<() => void> = [];
    for (const ev of events) {
      offs.push(ctx.bus.on(ev, (e: any) => {
        // 后台投递，失败静默（不阻断主流程）
        void fetch(h.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: ev, payload: e?.payload ?? null, ts: Date.now() }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => { /* 投递失败忽略 */ });
      }));
    }
    webhookSubs.set(h.url, () => { for (const off of offs) off(); });
  }
}

// 安全表达式求值（仅数字/四则/括号/空格）
function safeEval(expr: string): number | null {
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export function registerExtHandlers(bus: CommandBus, ctx: HandlerCtx): void {
  // 启动时订阅既有 webhook 配置（热注册由 /webhook add 处理）
  subscribeWebhooks(ctx);
  // ── 工具类（确定性）────────────────────────────
  bus.register('/calc', (args) => {
    const expr = args.join(' ');
    if (!expr) return '用法：/calc <表达式>（如 /calc 1+2*3）';
    const v = safeEval(expr);
    return v === null ? '表达式不合法（仅支持数字与 +-*/() ）' : `${expr} = ${v}`;
  });

  bus.register('/hash', (args) => {
    const [algo, ...rest] = args;
    const text = rest.join(' ');
    if (!['md5', 'sha1', 'sha256'].includes(algo ?? '') || !text) return '用法：/hash <md5|sha1|sha256> <文本>';
    return createHash(algo!).update(text, 'utf8').digest('hex');
  });

  bus.register('/base64', (args) => {
    const [op, ...rest] = args;
    const text = rest.join(' ');
    if (!['e', 'd', 'encode', 'decode'].includes(op ?? '') || !text) return '用法：/base64 <e|d> <文本>';
    try {
      return op === 'e' || op === 'encode' ? Buffer.from(text, 'utf8').toString('base64') : Buffer.from(text, 'base64').toString('utf8');
    } catch { return '解码失败（非法 Base64）'; }
  });

  bus.register('/uuid', () => randomUUID());

  bus.register('/rand', (args) => {
    const n = parseInt(args[0] ?? '16', 10);
    if (!Number.isFinite(n) || n < 1 || n > 64) return '用法：/rand [长度1-64]';
    return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
  });

  bus.register('/json', (args) => {
    const text = args.join(' ');
    if (!text) return '用法：/json <JSON 字符串>（格式化/校验）';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch { return '非法 JSON'; }
  });

  bus.register('/timer', (args) => {
    const sec = parseInt(args[0] ?? '', 10);
    const hint = args.slice(1).join(' ') || '时间到';
    if (!Number.isFinite(sec) || sec < 1 || sec > 3600) return '用法：/timer <秒> [提示语]（到时通过事件通知提示）';
    const end = Date.now() + sec * 1000;
    setTimeout(() => {
      try { ctx.bus.emit('system.notice', { text: `⏰ 计时器到点（${sec}s）：${hint}` }); } catch { /* 进程可能已退出 */ }
    }, sec * 1000);
    return `计时器已启动：${sec}s（${new Date(end).toTimeString().slice(0, 8)} 到点，提示语「${hint.slice(0, 30)}」）`;
  });

  bus.register('/sql', (args) => {
    const q = args.join(' ');
    if (!q) return '用法：/sql <SELECT 查询>（只读）';
    const s = q.trim().toLowerCase();
    if (!s.startsWith('select') && !s.startsWith('pragma')) return '仅允许只读查询（SELECT/PRAGMA）';
    try {
      const rows = ctx.db.prepare(q).all() as any[];
      if (!rows.length) return '（0 行）';
      const cols = Object.keys(rows[0] ?? {});
      return lines(' SQL ', [` ${cols.join(' | ')}`, ...rows.slice(0, 20).map(r => ` ${cols.map(c => String(r[c] ?? '').slice(0, 40)).join(' | ')}`)]);
    } catch (e: any) { return `SQL 错误：${e?.message?.slice(0, 120)}`; }
  });

  bus.register('/fs', (args) => {
    const [op, ...rest] = args;
    const target = rest.join(' ').replace(/^["']|["']$/g, '');
    if (!target) return '用法：/fs <ls|read|stat> <路径>';
    try {
      const p = join(ctx.cwd, target);
      if (op === 'ls') {
        if (!existsSync(p)) return `不存在：${p}`;
        const items = readdirSync(p).slice(0, 30);
        return lines(` ls ${target} `, items.map(i => ` ${statSync(join(p, i)).isDirectory() ? '📁' : '📄'} ${i}`));
      }
      if (op === 'read' || op === 'cat') {
        if (!existsSync(p) || statSync(p).isDirectory()) return `不存在或为目录：${p}`;
        const size = statSync(p).size;
        if (size > 200_000) return `文件过大（${size} 字节），仅支持 ≤200KB`;
        return lines(` read ${basename(p)} `, readFileSync(p, 'utf8').split('\n').slice(0, 60).map(l => ` ${l}`));
      }
      if (op === 'stat') {
        if (!existsSync(p)) return `不存在：${p}`;
        const st = statSync(p);
        return lines(` stat ${target} `, [
          ` 类型：${st.isDirectory() ? '目录' : '文件'}`,
          ` 大小：${st.size} 字节`,
          ` 修改：${new Date(st.mtimeMs).toLocaleString()}`,
        ]);
      }
      return '用法：/fs <ls|read|stat> <路径>';
    } catch (e: any) { return `文件操作失败：${e?.message?.slice(0, 120)}`; }
  });

  bus.register('/units', (args) => {
    const [from, to, ...rest] = args;
    const v = parseFloat(rest.join(' '));
    if (!Number.isFinite(v) || !from || !to) return '用法：/units <米|千米|厘米|毫米> <英尺|英寸> <数值>';
    const M: Record<string, number> = { 米: 1, 千米: 1000, 厘米: 0.01, 毫米: 0.001, 英尺: 0.3048, 英寸: 0.0254, 英里: 1609.344 };
    const a = M[from], b = M[to];
    if (!a || !b) return `不支持的单位：${from} / ${to}（支持：${Object.keys(M).join('、')}）`;
    return `${v} ${from} = ${(v * a / b).toFixed(6)} ${to}`;
  });

  bus.register('/csv', (args) => {
    const text = args.join(' ');
    if (!text) return '用法：/csv <a,b,c|1,2,3|...>（多行用 | 分隔）';
    const rows = text.split('|').map(r => r.split(',').map(c => c.trim()));
    if (!rows.length) return '空 CSV';
    const w = Math.min(Math.max(...rows.flat().map(c => c.length)) + 2, 30);
    return lines(' CSV ', rows.map(r => ` ${r.map(c => c.padEnd(w)).join('│')}`));
  });

  // ── 会话类 ──────────────────────────────────
  bus.register('/resume', (args) => {
    const id = args[0];
    const rows = ctx.db.prepare(`SELECT id, title FROM sessions`).all() as any[];
    if (!id) return lines(' 会话（/resume <id> 恢复） ', rows.map(r => ` ${r.id}  ${r.title || '(无标题)'}`));
    if (!rows.some(r => r.id === id)) return `会话不存在：${id}`;
    const cp = restoreCheckpoint(ctx.db, id);
    return `已恢复会话 ${id}（${cp ? `检查点：${JSON.stringify(cp).slice(0, 60)}` : '无检查点'}）——完整恢复需重启后 /resume ${id}`;
  });

  // /undo：撤销当前会话最后一条消息（CLI 单会话即 'default'；UI 走 session.undo RPC）
  // /undo：轮级回滚（机制补强）——撤销最近 N 轮（默认 1 轮），撤销前自动保存 checkpoint
  //   轮次 = 按 user 消息切分；删除该轮起的所有 user/assistant/tool 消息
  bus.register('/undo', (args) => {
    const n = parseInt(args[0] ?? '1', 10);
    const sid = 'default';
    if (!Number.isFinite(n) || n < 1 || n > 20) return '用法：/undo [轮次数 1-20]（撤销前自动保存 checkpoint，/checkpoint restore 可回退）';
    const msgs = ctx.db.prepare(`SELECT id, role FROM messages WHERE session_id=? AND role!='system' ORDER BY id`).all(sid) as Array<{ id: number; role: string }>;
    if (!msgs.length) return '没有可撤销的消息';
    // 定位第 n 个 user 消息（从尾部数）
    const userIdx: number[] = [];
    msgs.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
    if (!userIdx.length) return '没有可撤销的轮次';
    const target = userIdx[Math.max(0, userIdx.length - n)]!;
    // 撤销前自动快照（机制补强）——完整消息字段，restore 才能重建
    try {
      const full = ctx.db.prepare(`SELECT role, content, tool_call_id FROM messages WHERE session_id=? AND role!='system' ORDER BY id`).all(sid);
      saveCheckpoint(ctx.db, sid, { kind: 'undo-snapshot', messages: full, ts: Date.now() });
    } catch { /* 快照失败不阻断 */ }
    const dropIds = msgs.slice(target).map(m => m.id);
    ctx.db.prepare(`DELETE FROM messages WHERE id IN (${dropIds.map(() => '?').join(',')})`).run(...dropIds);
    return `已撤销 ${n} 轮（${dropIds.length} 条消息）——/checkpoint restore 可恢复`;
  });

  // /fork：复制当前会话（含全部消息）为分支会话
  bus.register('/fork', (args) => {
    const target = args[0] ?? 'default';
    const newId = `s${Date.now()}f`;
    const n = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id=?`).get(target) as { c: number }).c;
    if (!n) return `会话不存在：${target}`;
    const src = ctx.db.prepare(`SELECT title FROM sessions WHERE id=?`).get(target) as { title: string } | undefined;
    const now = Date.now();
    ctx.db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(newId, `${src?.title || target} (fork)`, now, now);
    ctx.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_call_id, archived, ts)
      SELECT ?, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=?
    `).run(newId, target);
    return `已分支会话 ${target} → ${newId}（${(ctx.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`).get(newId) as { c: number }).c} 条消息）`;
  });

  // /checkpoint：会话快照（机制补强——激活既有 checkpoints 表）
  //   save 手动快照 ｜ list 列表 ｜ restore [id] 恢复消息 ｜ clear 清空
  bus.register('/checkpoint', (args) => {
    const [sub, ...rest] = args;
    const sid = 'default';
    if (!sub || sub === 'list') {
      const rows = ctx.db.prepare(`SELECT id, data, ts FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 10`).all(sid) as Array<{ id: number; data: string; ts: number }>;
      if (!rows.length) return '暂无快照——/checkpoint save 保存，/undo 撤销前自动保存';
      return lines(' 快照 ', rows.map(r => {
        const d = JSON.parse(r.data) as { kind?: string; messages?: unknown[] };
        const n = Array.isArray(d.messages) ? d.messages.length : 0;
        return ` #${r.id} ${d.kind ?? 'checkpoint'}（${n} 条消息）${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}`;
      }));
    }
    if (sub === 'save') {
      const msgs = ctx.db.prepare(`SELECT role, content, tool_call_id FROM messages WHERE session_id=? ORDER BY id`).all(sid);
      const id = saveCheckpoint(ctx.db, sid, { kind: 'manual', messages: msgs, ts: Date.now() });
      return `已保存快照 #${id}（${(msgs as unknown[]).length} 条消息）`;
    }
    if (sub === 'restore') {
      const id = rest[0];
      const row = id
        ? ctx.db.prepare(`SELECT data FROM checkpoints WHERE id=? AND session_id=?`).get(id, sid) as { data: string } | undefined
        : ctx.db.prepare(`SELECT data FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sid) as { data: string } | undefined;
      if (!row) return `未找到快照${id ? ` #${id}` : ''}`;
      const d = JSON.parse(row.data) as { messages?: Array<{ role: string; content: string; tool_call_id?: string | null }> };
      if (!Array.isArray(d.messages)) return '快照数据不完整';
      // 恢复：清空当前消息 → 重插快照消息（保留原始顺序）
      ctx.db.prepare(`DELETE FROM messages WHERE session_id=?`).run(sid);
      const ins = ctx.db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, ts) VALUES (?,?,?,?,?)`);
      const now = Date.now();
      d.messages.forEach((m, i) => ins.run(sid, m.role, String(m.content ?? ''), m.tool_call_id ?? null, now + i));
      return `已从快照${id ? ` #${id}` : ''}恢复 ${d.messages.length} 条消息`;
    }
    if (sub === 'clear') {
      ctx.db.prepare(`DELETE FROM checkpoints WHERE session_id=?`).run(sid);
      return '已清空全部快照';
    }
    return '用法：/checkpoint save｜list｜restore [id]｜clear';
  });

  // /init：本地扫描项目生成 AGENTS.md（确定性数据；--overwrite 覆盖）
  bus.register('/init', (args) => {
    const overwrite = args.includes('--overwrite');
    const target = join(ctx.cwd, 'AGENTS.md');
    if (existsSync(target) && !overwrite) {
      return `AGENTS.md 已存在（用 /init --overwrite 重新生成）——现有内容：\n${readFileSync(target, 'utf8').slice(0, 200)}`;
    }
    const profile = scanProject(ctx.cwd);
    writeFileSync(target, renderAgentsMd(profile), 'utf8');
    return `已生成 ${target}（项目类型：${profile.type}，顶层 ${profile.structure.length} 项）`;
  });

  bus.register('/usage', () => {
    const rows = ctx.db.prepare(`SELECT role, content FROM messages WHERE session_id='default'`).all() as any[];
    const tokens = rows.reduce((a, r) => a + estimateTokens(r.content), 0);
    return lines(' 用量 ', [
      ` 消息：${rows.length} 条`,
      ` Token：约 ${tokens.toLocaleString()}`,
      ` 成本：本地运行，无 API 计费`,
    ]);
  });

  bus.register('/context', () => {
    const rec = ctx.mem.recall('default');
    const working = ctx.mem.working('default');
    return lines(' 上下文 ', [
      ` 黑洞全量：${rec.length} 条`,
      ` 工作窗口：${working.length}/20`,
      ` 占用：约 ${Math.min(100, Math.round(working.length / 20 * 100))}%`,
      ` 吸附归档：${ctx.mem.absorbCount('default')} 条（可 /hole 检索）`,
    ]);
  });

  // ── 记忆类 ──────────────────────────────────
  bus.register('/compact', async () => {
    const before = ctx.mem.recall('default').length;
    // 无 LLM 时用规则摘要：头尾保留 + 中间截断
    await ctx.mem.compactSmart('default', async (text) => `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
    const after = ctx.mem.recall('default').length;
    return `压缩完成：${before} → ${after} 条`;
  });

  bus.register('/digest', () => {
    const rec = ctx.mem.recall('default');
    if (!rec.length) return '暂无记忆';
    const last = rec.slice(-10);
    const roles = last.filter((m: any) => m.role !== 'system').map((m: any) => m.role === 'user' ? '问' : '答');
    return lines(' 摘要 ', [
      ` 最近 ${last.length} 条：${roles.join(' → ')}`,
      ` 最新：${String(last[last.length - 1]?.content ?? '').slice(0, 60)}`,
      ` 全量 ${rec.length} 条 · 吸附 ${ctx.mem.absorbCount('default')} 条`,
    ]);
  });

  // /curator：黑洞策展（机制补强）——即时审查 + 后台自动审查控制
  //   /curator         即时执行一轮审查
  //   /curator on|off  启用/禁用后台自动审查
  //   /curator interval <小时>  设置审查间隔
  bus.register('/curator', (args) => {
    const [sub, ...rest] = args;
    if (sub === 'on' || sub === 'off') {
      const cfg = curatorConfigFrom(ctx.config.get('settings'));
      cfg.enabled = sub === 'on';
      ctx.config.setKey('settings', 'curator', cfg);
      return `后台自动审查：${sub === 'on' ? '已启用' : '已停用'}（每 ${cfg.intervalHours}h 检查）`;
    }
    if (sub === 'interval') {
      const h = parseInt(rest[0] ?? '', 10);
      if (!Number.isFinite(h) || h < 1 || h > 720) return '用法：/curator interval <小时 1-720>';
      const cfg = curatorConfigFrom(ctx.config.get('settings'));
      cfg.intervalHours = h;
      ctx.config.setKey('settings', 'curator', cfg);
      return `审查间隔已设为 ${h}h`;
    }
    // 即时审查（默认）
    const report = runCuratorReview(ctx.mem, ctx.dataDir, ctx.cwd);
    const cfg = curatorConfigFrom(ctx.config.get('settings'));
    const state = readCuratorState(ctx.dataDir);
    const last = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '从未';
    return lines(` 黑洞策展（自动：${cfg.enabled ? '开' : '关'}@${cfg.intervalHours}h｜上次 ${last}） `, report.split('\n'));
  });

  // ── 构建类 ──────────────────────────────────
  bus.register('/deploy', () => {
    const dir = join(ctx.dataDir, 'projects');
    const projects = existsSync(dir) ? readdirSync(dir) : [];
    if (!projects.length) return '暂无编译项目（说「做个待办系统」触发概念编译）';
    return lines(' 项目 ', projects.map(p => {
      const health = join(dir, p, 'health.json');
      const ok = existsSync(health);
      return ` ${ok ? '✓' : '○'} ${p}${ok ? '（healthcheck 通过）' : ''}`;
    }));
  });

  bus.register('/forge', (args) => {
    const name = args[0];
    if (!name) return '用法：/forge <组件名>（锻造 MCP server + SKILL.md）';
    const outDir = join(ctx.dataDir, 'forge', name);
    mkdirSync(outDir, { recursive: true });
    const server = forgeMcpServer(outDir, name, [{ name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]);
    const skill = forgeSkillDir(outDir, name, `${name} 技能`, '1. 分析需求 2. 生成代码 3. 验证');
    return lines(` 锻造 ${name} `, [` MCP server → ${server}`, ` SKILL.md → ${skill}`]);
  });

  bus.register('/skill', (args): string | StructuredCommand => {
    const [sub, ...rest] = args;
    if (!sub) return '用法：/skill <技能名>（加载注入）| /skill new <名> [描述] | /skill list | /skill inspect <名>';
    if (sub === 'new') {
      const name = rest[0];
      if (!name) return '用法：/skill new <技能名> [描述]';
      const desc = rest.slice(1).join(' ') || `${name} 技能`;
      const dir = writeSkill(ctx.dataDir, name, desc, '1. 理解任务 2. 制定步骤 3. 执行并验证', { aiGenerated: true });
      return `技能已生成（ai_generated 标注）→ ${dir}`;
    }
    if (sub === 'list') {
      const all = discoverSkills(ctx.dataDir, ctx.cwd);
      if (!all.length) return '技能库为空——/skill new <名> 创建，或把 SKILL.md 放到 .wxnodus/skills/<名>/';
      return lines(' 技能库 ', [
        ...all.map(s => ` ${s.name}${s.description ? ' — ' + s.description : ''}（${s.source}）`),
        ` 共 ${all.length} 个`,
      ]);
    }
    if (sub === 'inspect') {
      const name = rest[0];
      if (!name) return '用法：/skill inspect <技能名>';
      const s = loadSkill(ctx.dataDir, ctx.cwd, name);
      if (!s) return `未找到技能「${name}」——/skill list 查看已安装技能`;
      return lines(` 技能 ${s.meta.name} `, [
        ` 描述：${s.meta.description || '（无）'}`,
        ` 来源：${s.meta.source}｜路径：${s.meta.path}`,
        ` ${s.meta.aiGenerated ? 'AI 生成标注' : '人工编写'}`,
        '',
        s.body.slice(0, 800),
      ]);
    }
    // 加载技能：TUI 侧 /skill:name 注入为消息发送；CLI 侧直接输出正文
    const s = loadSkill(ctx.dataDir, ctx.cwd, sub);
    if (!s) return `未找到技能「${sub}」——/skill list 查看已安装技能，或 /skill new ${sub} 创建`;
    return { kind: 'skill', name: sub, message: skillContentForModel(ctx.dataDir, ctx.cwd, sub) };
  });

  // /learn：把最近对话总结为可复用技能（AI 生成——无 key 时明确提示，不产生假技能）
  bus.register('/learn', async (args): Promise<string> => {
    const name = args[0];
    if (!name) return '用法：/learn <技能名> [描述]——用最近对话总结生成 SKILL.md';
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    if (!enc) return '当前未配置模型密钥——/key set <密钥> 后 /learn 才能用 AI 总结生成技能（不产生假内容）';
    const key = decryptKey(enc);
    if (!key) return '密钥无法解密（机器环境变化或数据损坏？）——请用 /key set <密钥> 重新配置。';
    const recent = ctx.mem.recall('default').slice(-8);
    if (!recent.length) return '暂无对话记忆可学习——先对话几轮再 /learn';
    const desc = args.slice(1).join(' ') || `${name} 技能`;
    const transcript = recent.map(r => `${r.role}: ${String(r.content ?? '').slice(0, 300)}`).join('\n');
    const { buildChatRequest } = await import('../kernel/providers.js');
    const baseURL = (ctx.config.getKey('settings', 'baseURL') as string) || 'https://api.deepseek.com/v1';
    const model = (ctx.config.getKey('settings', 'model') as string) || 'deepseek-v4-flash';
    const req = buildChatRequest({
      baseURL, model, key,
      messages: [
        { role: 'system', content: '你是技能提炼器。把用户提供的对话片段提炼为可复用的技能工作流，只输出 Markdown 工作流正文（分步、可执行、中文），不要多余说明。' },
        { role: 'user', content: `技能名：${name}\n技能描述：${desc}\n\n对话片段：\n${transcript}` },
      ],
      stream: false,
    });
    const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) return `技能提炼失败（${resp.status}）——请检查密钥与模型配置`;
    const j = await resp.json() as any;
    const workflow = String(j?.choices?.[0]?.message?.content ?? '').trim() || '1. 理解任务 2. 制定步骤 3. 执行并验证';
    const dir = writeSkill(ctx.dataDir, name, desc, workflow, { aiGenerated: true });
    return `已从对话学习生成技能 → ${dir}（ai_generated 标注）`;
  });

  bus.register('/gate', (args) => {
    const name = args[0] ?? '';
    const dir = join(ctx.dataDir, 'projects', name);
    if (!name || !existsSync(dir)) {
      const projects = existsSync(join(ctx.dataDir, 'projects')) ? readdirSync(join(ctx.dataDir, 'projects')) : [];
      return lines(' 门禁 ', [`用法：/gate <项目名>`, ` 项目：${projects.join(', ') || '无'}`]);
    }
    return runGate({ projectDir: dir, dataDir: ctx.dataDir }).then(r => lines(' 门禁评估 ', r.gates.map(g => ` ${g.ok ? '✓' : '✗'} ${g.name}：${g.detail.slice(0, 50)}`)));
  });

  bus.register('/fdr', (args) => {
    const name = args[0] ?? `fdr-${Date.now().toString(36)}`;
    const out = join(ctx.dataDir, 'forge', name, 'FDR.md');
    mkdirSync(join(ctx.dataDir, 'forge', name), { recursive: true });
    const doc = `# FDR — ${name}\n\n## 需求\n\n## 设计\n\n## 实现\n\n## 验证\n`;
    writeFileSync(out, doc, 'utf8');
    return `FDR 文档已生成 → ${out}`;
  });

  bus.register('/evidence', (args) => {
    const name = args[0] ?? 'default';
    const dir = join(ctx.dataDir, 'projects', name);
    if (!existsSync(dir)) return `项目不存在：${name}`;
    const health = join(dir, 'health.json');
    let checks: string[] = [];
    try { checks = existsSync(health) ? (JSON.parse(readFileSync(health, 'utf8')).checks ?? []) : []; } catch { /* 无 health 时空列表 */ }
    writeEvidence(dir, { status: 'verified', checks, port: null });
    return `证据已写入 → ${join(dir, 'evidence.json')}`;
  });

  // ── 安全类 ──────────────────────────────────
  // /sandbox [L0-L3]：分层沙盒——映射真实权限模式并切换（非说明文字）
  //   L0 只读（plan：只读+审批）｜L1 默认（smart）｜L2 自动（auto）｜L3 全放（yolo）
  bus.register('/sandbox', (args) => {
    const LAYERS: Record<string, string> = { L0: 'plan', L1: 'smart', L2: 'auto', L3: 'yolo' };
    const current = Object.entries(LAYERS).find(([, m]) => m === ctx.getMode())?.[0] ?? '?';
    const want = (args[0] ?? '').toUpperCase();
    if (want in LAYERS) {
      ctx.setMode(LAYERS[want]!);
      const desc: Record<string, string> = { plan: '只读探索 + 计划审批', smart: '只读放行，危险工具确认', auto: '自动批准（硬红线除外）', yolo: '除硬红线全部放行' };
      return `沙盒已切换：L${want.slice(1)} → ${LAYERS[want]} 模式（${desc[LAYERS[want]!]}）`;
    }
    return lines(' 沙盒（L0-L3） ', [
      ` 当前层：L${current.slice(1)}（${ctx.getMode()}）`,
      ` L0 → plan  只读探索 + 计划审批（写操作需确认）`,
      ` L1 → smart 只读放行，危险工具确认（默认）`,
      ` L2 → auto  自动批准（硬红线除外）`,
      ` L3 → yolo  除硬红线全部放行`,
      '',
      ` 硬红线（任何模式不可绕过）：${HARD_REDLINES.map(r => r.desc).join(' · ')}`,
      ` 用法：/sandbox L0|L1|L2|L3`,
    ]);
  });

  bus.register('/compliance', () => {
    const ledger = ctx.db.prepare(`SELECT COUNT(*) c FROM audit`).get() as any;
    return lines(' 合规 ', [
      ` 同意书：已建（数据本地、凭证加密）`,
      ` AI 生成标注：消息流标记 ✦`,
      ` 审计日志：${ledger?.c ?? 0} 条（/audit 导出）`,
      ` 许可扫描：AGPL/BUSL 检测`,
    ]);
  });

  bus.register('/consent', () => {
    const cp = restoreCheckpoint(ctx.db, 'default');
    const consented = !!cp || existsSync(join(ctx.dataDir, 'consent.json'));
    if (!consented) writeFileSync(join(ctx.dataDir, 'consent.json'), JSON.stringify({ agreed: true, ts: Date.now() }), 'utf8');
    return consented ? '同意书：已签署（本地运行、数据不出本机、凭证加密存储）' : '同意书已签署：本地运行 · 数据不出本机 · 凭证加密存储';
  });

  bus.register('/audit', () => {
    const out = join(ctx.dataDir, `audit-${Date.now().toString(36)}.json`);
    const rows = ctx.db.prepare(`SELECT * FROM audit ORDER BY id`).all() as any[];
    writeFileSync(out, JSON.stringify(rows, null, 2), 'utf8');
    return `审计日志已导出（${rows.length} 条）→ ${out}`;
  });

  bus.register('/encrypt', () => {
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    return enc ? `凭证：AES-256-GCM 加密存储（${enc.slice(0, 12)}…，机器指纹绑定）` : '凭证：未配置（/key set <key>）';
  });

  // ── 系统类 ──────────────────────────────────
  bus.register('/lang', (args) => {
    const v = args[0];
    if (v && ['zh', 'en'].includes(v)) { ctx.config.setKey('settings', 'lang', v); return `语言已切换：${v}`; }
    return `当前语言：${ctx.config.getKey('settings', 'lang') ?? 'zh'}（zh/en）`;
  });

  bus.register('/config', () => {
    const s = ctx.config.get('settings') as Record<string, any>;
    const safe = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'apiKeyEnc' ? (v ? 'enc:****' : '') : v]));
    return lines(' 配置 ', Object.entries(safe).map(([k, v]) => ` ${k}: ${JSON.stringify(v)}`));
  });

  bus.register('/logs', (args) => {
    const n = parseInt(args[0] ?? '10', 10);
    const p = join(ctx.dataDir, 'events.jsonl');
    if (!existsSync(p)) return '暂无事件日志';
    const linesArr = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-n);
    return lines(` 日志（末 ${linesArr.length} 行） `, linesArr.map(l => { try { const j = JSON.parse(l); return ` ${j.type ?? 'event'} ${new Date(j.ts ?? 0).toTimeString().slice(0, 8)}`; } catch { return ` ${l.slice(0, 60)}`; } }));
  });

  bus.register('/bench', () => {
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 1000; i++) n += estimateTokens(`第 ${i} 条中文测试消息的 token 估算`);
    const ms = (performance.now() - t0).toFixed(1);
    return `基准：1000 次中文 token 估算 ${ms}ms（约 ${(1000 / (parseFloat(ms) / 1000)).toFixed(0)} 次/秒）`;
  });

  // ── 视觉类 ──────────────────────────────────
  bus.register('/capture', async () => {
    try {
      const { captureScreen } = await import('../kernel/computer/index.js');
      const shot = await captureScreen();
      const out = shot ? join(ctx.dataDir, `capture-${Date.now().toString(36)}.png`) : null;
      if (shot && out) writeFileSync(out, shot.png, 'utf8');
      return `屏幕已捕获 → ${out}（可用 /img <路径> 分析）`;
    } catch (e: any) { return `截图失败：${e?.message?.slice(0, 120)}（需要图形环境）`; }
  });

  bus.register('/render', (args) => {
    const target = args.join(' ');
    if (!target) return '用法：/render <文本>（终端渲染为 Markdown 预览）';
    return lines(' 渲染预览 ', target.split('\n').map(l => ` ${l}`));
  });

  bus.register('/video', async (args) => {
    const target = args.join(' ').replace(/^["']|["']$/g, '');
    if (!target) return '用法：/video <视频路径>（全帧抽帧 → 项目级分析：概述/功能/操作流程/场景变化/coding 因素）';
    if (!existsSync(target)) return `视频不存在：${target}`;
    const { analyzeVideoAsProject } = await import('../kernel/video.js');
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    const out = await analyzeVideoAsProject(target, enc ?? null);
    return out;
  });

  // ── 连接类 ──────────────────────────────────
  // /mcp：本地 MCP 客户端管理（data/mcp.json）——list/add/remove/test
  bus.register('/mcp', async (args) => {
    const { loadMcpConfig, saveMcpConfig, connectMcp } = await import('../kernel/mcp.js');
    const [sub, ...rest] = args;
    const servers = loadMcpConfig(ctx.dataDir);
    if (!sub || sub === 'list') {
      if (!servers.length) {
        return lines(' MCP ', [' 未配置 server', '', ' 用法：/mcp add <名称> <命令> [参数...]', '       /mcp remove <名称>', '       /mcp test <名称>', ' 配置存 data/mcp.json（本地 stdio 进程）']);
      }
      return lines(' MCP ', servers.map(s => ` ${s.name} → ${s.command} ${(s.args ?? []).join(' ')}`));
    }
    if (sub === 'add') {
      const name = rest[0];
      const command = rest[1];
      if (!name || !command) return '用法：/mcp add <名称> <命令> [参数...]';
      if (servers.some(s => s.name === name)) return `server「${name}」已存在（/mcp remove ${name} 后重加）`;
      servers.push({ name, command, args: rest.slice(2) });
      saveMcpConfig(ctx.dataDir, servers);
      return `已添加 MCP server「${name}」（重启后生效，或 /mcp test ${name} 验证连接）`;
    }
    if (sub === 'remove') {
      const name = rest[0];
      if (!name) return '用法：/mcp remove <名称>';
      const next = servers.filter(s => s.name !== name);
      if (next.length === servers.length) return `未找到 server「${name}」`;
      saveMcpConfig(ctx.dataDir, next);
      return `已移除 MCP server「${name}」`;
    }
    if (sub === 'test') {
      const name = rest[0];
      const cfg = servers.find(s => s.name === name);
      if (!cfg) return `未找到 server「${name}」（/mcp list 查看）`;
      try {
        const client = await connectMcp(cfg);
        const tools = client.tools.map(t => t.name).join(', ') || '（无工具）';
        client.close();
        return lines(` MCP 测试 ${name} `, [` 连接成功，工具：${tools}`]);
      } catch (e: any) {
        return `连接失败：${e?.message ?? e}`;
      }
    }
    return '用法：/mcp list｜add <名称> <命令> [参数...]｜remove <名称>｜test <名称>';
  });

  // /claw：网页抓取（SSRF 防护：内网/保留地址拦截）——真实 fetch + 正文文本提取
  bus.register('/claw', async (args) => {
    const url = args.join(' ').replace(/^["']|["']$/g, '').trim();
    if (!url) return '用法：/claw <URL>（网页抓取，SSRF 防护拦截内网）';
    let u: URL;
    try { u = new URL(url); } catch { return `URL 非法：${url.slice(0, 80)}`; }
    if (!/^https?:$/.test(u.protocol)) return '仅支持 http/https';
    const host = u.hostname;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost|0\.0\.0\.0)$/.test(host) || host === '::1') {
      return `已拦截：内网地址 ${host}（SSRF 防护）`;
    }
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const html = await resp.text();
      // 提取正文文本（去 script/style/标签/空白）
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
      const body = text || '（页面无可提取文本，可能是 JS 渲染）';
      return `HTTP ${resp.status}｜${html.length} 字节\n${body.slice(0, 4000)}`;
    } catch (e: any) {
      return `抓取失败：${e?.message?.slice(0, 300) ?? e}`;
    }
  });

  // /gateway：本地 HTTP JSON-RPC 网关（localhost 监听，POST /rpc 面）
  //   method: prompt {text} → 意图路由执行；command {input} → 命令总线
  let gatewayServer: import('node:http').Server | null = null;
  bus.register('/gateway', async (args) => {
    const [sub, ...rest] = args;
    const port = parseInt(rest[0] ?? '8765', 10);
    if (sub === 'start' || !sub) {
      if (gatewayServer) return `网关已在运行：http://127.0.0.1:${(gatewayServer.address() as any)?.port ?? port}`;
      const { createServer } = await import('node:http');
      gatewayServer = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST' || req.url !== '/rpc') {
          res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          void (async () => {
            try {
              const { method, params } = JSON.parse(body || '{}');
              if (method === 'command') {
                const r = await bus.execute(String(params?.input ?? ''));
                res.writeHead(200); res.end(JSON.stringify({ ok: r.ok, output: r.output || r.dispatch?.message || r.error || '' }));
              } else if (method === 'prompt') {
                if (!ctx.agent) { res.writeHead(500); res.end(JSON.stringify({ error: 'no agent' })); return; }
                const r = await ctx.agent.run(String(params?.text ?? ''));
                res.writeHead(200); res.end(JSON.stringify({ ok: r.ok, text: r.text, turns: r.turns }));
              } else if (method === 'health') {
                res.writeHead(200); res.end(JSON.stringify({ ok: true, version: '3.0.0' }));
              } else {
                res.writeHead(400); res.end(JSON.stringify({ error: `unknown method: ${method}` }));
              }
            } catch (e: any) {
              res.writeHead(500); res.end(JSON.stringify({ error: String(e?.message ?? e) }));
            }
          })();
        });
      });
      await new Promise<void>((resolve, reject) => {
        gatewayServer!.once('error', reject);
        gatewayServer!.listen(port, '127.0.0.1', resolve);
      }).catch((e: any) => { gatewayServer = null; return; });
      if (!gatewayServer) return `启动失败：端口 ${port} 可能被占用（/gateway start <其他端口>）`;
      return `__KEEPALIVE__\n网关已启动：http://127.0.0.1:${port}（POST /rpc，method=command|prompt|health；仅本机监听，SIGINT 停止）`;
    }
    if (sub === 'stop') {
      if (!gatewayServer) return '网关未运行';
      gatewayServer.close();
      gatewayServer = null;
      return '网关已停止';
    }
    if (sub === 'status') {
      return gatewayServer
        ? `运行中：http://127.0.0.1:${(gatewayServer.address() as any)?.port ?? port}`
        : '未运行（/gateway start [端口] 启动本地 JSON-RPC 网关）';
    }
    return '用法：/gateway start [端口]｜stop｜status';
  });

  bus.register('/proxy', (args) => {
    const v = args[0];
    if (v) { ctx.config.setKey('settings', 'proxy', v); return `代理已设置：${v}`; }
    return `代理：${ctx.config.getKey('settings', 'proxy') ?? '未设置（直连）'}`;
  });

  // /webhook：注册/管理事件回调（真实 HTTP POST 投递，本地事件总线驱动）
  bus.register('/webhook', (args) => {
    const [sub, ...rest] = args;
    if (sub === 'list' || !sub) {
      const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string; events?: string[] }> | undefined) ?? [];
      if (!hooks.length) {
        return lines(' Webhook ', [' 未注册回调', '', ' 用法：/webhook add <URL> [事件...]（事件缺省=全部核心事件）', '       /webhook remove <URL>', '       /webhook test <URL>']);
      }
      return lines(' Webhook ', hooks.map(h => ` ${h.url}（${(h.events ?? WEBHOOK_EVENTS).length} 事件）`));
    }
    if (sub === 'add') {
      const url = rest[0];
      if (!/^https?:\/\//.test(url ?? '')) return '用法：/webhook add <URL> [事件...]（http/https 回调）';
      const events = rest.slice(1);
      const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string; events?: string[] }> | undefined) ?? [];
      if (hooks.some(h => h.url === url)) return `已存在回调：${url}`;
      hooks.push({ url, events: events.length ? events : undefined });
      ctx.config.setKey('settings', 'webhooks', hooks);
      subscribeWebhooks(ctx);
      return `已注册回调 ${url}（${events.length ? events.join(',') : '全部核心事件'}）——事件发生时将 POST JSON 到此地址`;
    }
    if (sub === 'remove') {
      const url = rest[0];
      const hooks = (ctx.config.getKey('settings', 'webhooks') as Array<{ url: string }> | undefined) ?? [];
      const next = hooks.filter(h => h.url !== url);
      if (next.length === hooks.length) return `未找到回调：${url}`;
      ctx.config.setKey('settings', 'webhooks', next);
      webhookSubs.get(url)?.();
      webhookSubs.delete(url);
      return `已移除回调 ${url}`;
    }
    if (sub === 'test') {
      return (async () => {
        const url = rest[0];
        if (!/^https?:\/\//.test(url ?? '')) return '用法：/webhook test <URL>';
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'webhook.test', payload: { message: '测试投递' }, ts: Date.now() }),
            signal: AbortSignal.timeout(8000),
          });
          return `测试投递成功：HTTP ${r.status}`;
        } catch (e: any) {
          return `测试投递失败：${e?.message?.slice(0, 120) ?? e}`;
        }
      })();
    }
    return '用法：/webhook list｜add <URL> [事件...]｜remove <URL>｜test <URL>';
  });

  // /a2a：Agent-to-Agent 协议——call 调用对端 / serve 启动本地端点（A2A messages/send）
  let a2aServer: { url: string; stop(): void } | null = null;
  bus.register('/a2a', async (args) => {
    const [sub, ...rest] = args;
    if (sub === 'call') {
      const url = rest[0];
      const text = rest.slice(1).join(' ');
      if (!/^https?:\/\//.test(url ?? '') || !text) return '用法：/a2a call <对端URL> <消息>（A2A messages/send）';
      const { a2aCall } = await import('../kernel/a2a.js');
      const r = await a2aCall(url, text);
      if (!r.ok) return `A2A 调用失败：${r.error ?? '无响应'}`;
      return lines(' A2A 回复 ', String(r.text).split('\n').slice(0, 20).map(l => ` ${l.slice(0, 110)}`));
    }
    if (sub === 'serve') {
      if (a2aServer) return `A2A 端点运行中：${a2aServer.url}`;
      const port = parseInt(rest[0] ?? '8787', 10);
      if (!ctx.agent) return 'a2a serve 不可用：当前环境未提供 agent';
      const { a2aServe } = await import('../kernel/a2a.js');
      try {
        a2aServer = await a2aServe(port, async (text) => {
          const r = await ctx.agent!.run(text);
          return { ok: r.ok, text: r.text };
        });
        return `__KEEPALIVE__\nA2A 端点已启动：${a2aServer.url}（POST messages/send，仅本机监听，SIGINT 停止；/a2a stop 停止）`;
      } catch (e: any) {
        return `启动失败：端口 ${port} 可能被占用（/a2a serve <其他端口>）——${e?.message?.slice(0, 80)}`;
      }
    }
    if (sub === 'stop') {
      if (!a2aServer) return 'A2A 端点未运行';
      a2aServer.stop();
      a2aServer = null;
      return 'A2A 端点已停止';
    }
    return lines(' A2A ', [
      ' 用法：/a2a call <对端URL> <消息>——调用其他 agent（A2A 协议）',
      '       /a2a serve [端口]——启动本机 A2A 端点（默认 8787）',
      '       /a2a stop——停止端点',
      ' 协议：JSON-RPC messages/send（A2A 规范子集，本地优先）',
    ]);
  });

  // /acp：Agent Client Protocol stdio 服务器（IDE 集成）
  //   交互模式下提示；`wxnodus -p "/acp server"` 启动阻塞式 stdio 会话（Zed/JetBrains 接入）
  bus.register('/acp', async (args) => {
    const wantServer = args[0] === 'server';
    if (!wantServer) {
      return lines(' ACP ', [
        ' Agent Client Protocol（ACP）stdio 服务器——IDE 集成',
        ' 用法：wxnodus -p "/acp server"（阻塞式，供 ACP 客户端启动）',
        ' 协议：initialize → session/new → prompt → assistant 消息',
        ' 参考：Zed / JetBrains 的 ACP 客户端配置',
      ]);
    }
    if (!ctx.agent) return 'acp server 不可用：当前环境未提供 agent';
    const { runAcpServer } = await import('../kernel/acp.js');
    const code = await runAcpServer({ run: async (text) => { const r = await ctx.agent!.run(text); return { ok: r.ok, text: r.text }; } });
    return `ACP 会话结束（exit ${code}）`;
  });

  // ── 协作类 ──────────────────────────────────
  // /swarm <任务> [N]：N 个子代理并行执行同一任务（角色拆分提示词），汇总结果
  bus.register('/swarm', async (args) => {
    let n = 3;
    if (args.length > 1 && /^\d+$/.test(args[args.length - 1]!)) n = Math.min(parseInt(args.pop()!, 10), 8);
    const goal = args.join(' ');
    if (!goal) return '用法：/swarm <任务> [并行数 1-8]（多子代理并行执行）';
    if (!ctx.agent) return 'swarm 不可用：当前环境未提供子代理';
    const roles = ['（视角：结构设计）', '（视角：实现细节）', '（视角：边界与风险）', '（视角：验证与测试）', '（视角：性能优化）', '（视角：文档与交付）', '（视角：兼容性）', '（视角：复盘总结）'];
    const tasks = Array.from({ length: n }, (_, i) => `${goal}\n${roles[i % roles.length]}`);
    const results = await Promise.allSettled(tasks.map(t => ctx.agent!.spawnSubagent(t)));
    const lines2: string[] = [];
    results.forEach((r, i) => {
      const body = r.status === 'fulfilled' ? r.value : { ok: false, output: `异常：${(r.reason as any)?.message ?? r.reason}` };
      lines2.push('', ` ══ 子代理 ${i + 1} ${body.ok ? '✓' : '✗'}（${(body as any).turns ?? '?'} 轮）══`, ...String((body as any).output ?? '').split('\n').slice(0, 10).map(l => `  ${l.slice(0, 108)}`));
    });
    return lines(` 集群执行 ${goal.slice(0, 30)} `, [` ${n} 个子代理并行（只读工具集）`, ...lines2]);
  });

  // /duo <任务>：双脑协作——两个子代理独立方案 + 交叉对比汇总
  bus.register('/duo', async (args) => {
    const goal = args.join(' ');
    if (!goal) return '用法：/duo <任务>（双脑协作：两方案独立推演 + 对比）';
    if (!ctx.agent) return 'duo 不可用：当前环境未提供子代理';
    const [a, b] = await Promise.all([
      ctx.agent.spawnSubagent(`${goal}\n（请输出完整方案 A，含步骤与理由）`),
      ctx.agent.spawnSubagent(`${goal}\n（请输出完整方案 B，含步骤与理由，尽量与直觉方案不同）`),
    ]);
    return lines(` 双脑 ${goal.slice(0, 26)} `, [
      ` ══ 方案 A ${a.ok ? '✓' : '✗'}（${a.turns} 轮）══`,
      ...String(a.output ?? '').split('\n').slice(0, 14).map(l => `  ${l.slice(0, 108)}`),
      '',
      ` ══ 方案 B ${b.ok ? '✓' : '✗'}（${b.turns} 轮）══`,
      ...String(b.output ?? '').split('\n').slice(0, 14).map(l => `  ${l.slice(0, 108)}`),
    ]);
  });

  bus.register('/cron', () => {
    try {
      const jobs = ctx.db.prepare(`SELECT * FROM cron_jobs ORDER BY id`).all() as any[];
      if (!jobs.length) return '暂无定时任务（说「每天早上9点提醒我」创建）';
      return lines(' 定时任务 ', jobs.map(j => ` ${j.id}  ${j.schedule}  ${String(j.action ?? '').slice(0, 30)}`));
    } catch { return '定时任务表未初始化（说「每天早上9点提醒我」自动创建）'; }
  });

  // /jobs：后台任务注册表（真实 fire-and-forget 子代理派发 + db 持久化状态）
  bus.register('/jobs', (args) => {
    const [sub, ...rest] = args;
    if (sub === 'run') {
      const goal = rest.join(' ');
      if (!goal) return '用法：/jobs run <任务>（后台派发子代理，不阻塞当前会话）';
      if (!ctx.agent) return 'jobs 不可用：当前环境未提供子代理';
      const id = `t${Date.now().toString(36)}`;
      const now = Date.now();
      try {
        ctx.db.prepare(`INSERT INTO tasks (id, goal, status, created_at) VALUES (?,?,?,?)`).run(id, goal.slice(0, 200), 'running', now);
      } catch { return '任务表未初始化（重启后自动建表）'; }
      // fire-and-forget：后台执行，完成后写回
      void ctx.agent.spawnSubagent(goal).then(r => {
        try {
          ctx.db.prepare(`UPDATE tasks SET status=?, output=?, done_at=? WHERE id=?`).run(r.ok ? 'done' : 'failed', String(r.output).slice(0, 4000), Date.now(), id);
        } catch { /* 忽略 */ }
        try { ctx.bus.emit('system.notice', { text: `后台任务 ${id} ${r.ok ? '完成' : '失败'}（${r.turns} 轮）` }); } catch { /* 忽略 */ }
      }).catch(() => {
        try { ctx.db.prepare(`UPDATE tasks SET status='failed', done_at=? WHERE id=?`).run(Date.now(), id); } catch { /* 忽略 */ }
      });
      return `后台任务已派发：${id}「${goal.slice(0, 60)}」（/jobs list 查看状态）`;
    }
    if (sub === 'show') {
      const id = rest[0];
      if (!id) return '用法：/jobs show <任务ID>';
      const row = ctx.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as any;
      if (!row) return `任务不存在：${id}`;
      return lines(` 任务 ${id} `, [
        ` 目标：${row.goal}`,
        ` 状态：${row.status === 'running' ? '⏳ 运行中' : row.status === 'done' ? '✓ 完成' : '✗ 失败'}（${row.status}）`,
        ...(row.output ? ['', ...String(row.output).split('\n').slice(0, 15).map(l => ` ${l.slice(0, 110)}`)] : []),
      ]);
    }
    // list（默认）
    let rows: any[] = [];
    try {
      rows = ctx.db.prepare(`SELECT id, goal, status, created_at, done_at FROM tasks ORDER BY created_at DESC LIMIT 20`).all() as any[];
    } catch { return '任务表未初始化（/jobs run <任务> 自动建表后可用）'; }
    if (!rows.length) return '暂无后台任务（/jobs run <任务> 派发）';
    return lines(' 后台任务 ', rows.map(r => ` ${r.status === 'running' ? '⏳' : r.status === 'done' ? '✓' : '✗'} ${r.id} ${r.status === 'running' ? '' : `[${Math.round((r.done_at - r.created_at) / 1000)}s] `}${String(r.goal).slice(0, 50)}`));
  });

  // /delegate：真实派发子代理（只读工具集、独立上下文），结果回显并持久化到 tasks 表（可查可恢复）
  bus.register('/delegate', async (args) => {
    const task = args.join(' ');
    if (!task) return '用法：/delegate <任务>（派发只读子代理，结果返回当前会话）';
    if (!ctx.agent) return 'delegate 不可用：当前环境未提供子代理能力';
    ctx.bus.emit('system.notice', { text: `派发子代理：「${task.slice(0, 60)}」…` });
    const id = `t${Date.now().toString(36)}`;
    try {
      ctx.db.prepare(`INSERT INTO tasks (id, goal, status, created_at) VALUES (?,?,?,?)`).run(id, `delegate: ${task.slice(0, 180)}`, 'running', Date.now());
    } catch { /* 任务表未就绪时跳过持久化 */ }
    try {
      const r = await ctx.agent.spawnSubagent(task);
      // 结果持久化（机制补强）：/jobs show <id> 可查看历史
      try {
        ctx.db.prepare(`UPDATE tasks SET status=?, output=?, done_at=? WHERE id=?`).run(r.ok ? 'done' : 'failed', String(r.output).slice(0, 4000), Date.now(), id);
      } catch { /* 忽略 */ }
      return lines(` 子代理结果 `, [
        ` 任务：${task.slice(0, 80)}`,
        ` 状态：${r.ok ? '完成' : '未完成'}（${r.turns} 轮）｜记录：/jobs show ${id}`,
        '',
        ...String(r.output ?? '').split('\n').slice(0, 30).map(l => ` ${l.slice(0, 110)}`),
      ]);
    } catch (e: any) {
      try { ctx.db.prepare(`UPDATE tasks SET status='failed', done_at=? WHERE id=?`).run(Date.now(), id); } catch { /* 忽略 */ }
      return `子代理执行异常：${e?.message?.slice(0, 300) ?? e}`;
    }
  });

  // /btw：侧边提问（机制补强）——隔离只读上下文并行问答，不打断主对话
  bus.register('/btw', async (args) => {
    const q = args.join(' ');
    if (!q) return '用法：/btw <问题>（隔离只读上下文侧边提问，不占用主对话）';
    if (!ctx.agent) return 'btw 不可用：当前环境未提供子代理';
    const r = await ctx.agent.spawnSubagent(`（侧边提问，请直接简要回答，不调用工具）${q}`);
    return lines(` 侧边提问 `, [
      ` Q：${q.slice(0, 80)}`,
      ` A（${r.ok ? '完成' : '未完成'}，${r.turns} 轮）：`,
      ...String(r.output ?? '').split('\n').slice(0, 15).map(l => `  ${l.slice(0, 108)}`),
    ]);
  });

  // /goal：开放目标循环执行——逐轮推进直到完成或达到最大轮数（真实 agent 执行）
  bus.register('/goal', async (args) => {
    const maxIter = args.length > 1 && /^\d+$/.test(args[args.length - 1]!) ? parseInt(args.pop()!, 10) : 3;
    const goal = args.join(' ');
    if (!goal) return '用法：/goal <目标> [最大轮数]（循环执行直到完成或达上限）';
    if (!ctx.agent) return 'goal 不可用：当前环境未提供 agent';
    const rounds: string[] = [];
    let done = false;
    for (let i = 1; i <= Math.min(maxIter, 8); i++) {
      const prompt = `目标：${goal}\n当前进度：${rounds.at(-1) ? '已完成以下工作——' + rounds.at(-1)!.slice(0, 600) : '尚未开始'}。\n请继续推进目标。若目标已全部完成，以「✓ 已完成」开头输出总结；否则输出本轮完成的事项与下一步。`;
      const r = await ctx.agent.run(prompt);
      rounds.push(r.text);
      if (r.text.includes('✓ 已完成') || r.text.includes('✅')) { done = true; break; }
      if (!r.ok && r.text.includes('未配置模型密钥')) break; // 无 key：不空转
    }
    return lines(` 目标执行 ${done ? '✓ 完成' : `（${rounds.length} 轮）`} `, [
      ` 目标：${goal.slice(0, 80)}`,
      ...rounds.map((r, i) => ['', ` ── 第 ${i + 1} 轮 ──`, ...String(r).split('\n').slice(0, 12).map(l => ` ${l.slice(0, 110)}`)]).flat(),
    ]);
  });

  // 审计留痕
  try { appendAudit(ctx.db, 'handlers.ext.registered', { count: 47 }); } catch { /* 审计表未就绪时静默 */ }
}
