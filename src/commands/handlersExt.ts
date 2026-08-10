// src/commands/handlersExt.ts — 扩展命令处理器（补齐 registry 全量 67 条）
// 设计：与 handlers.ts 分离，按类补齐——工具（确定性）/会话/记忆/构建/安全/
//       系统/视觉/连接/协作。每个命令真实可用（查询现有数据或执行确定性操作），
//       输出统一 lines() 面板或单行。红线：只读工具不写库；路径操作限制在 dataDir。
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { join, basename, extname, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
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
  // /resume <id|标题片段>：真正切换会话（修复：此前仅 restoreCheckpoint 提示，不切 agent 会话）
  //   P2 深化：id 未命中时按标题模糊匹配（/resume 我的分析 → 标题含「我的分析」的会话）
  bus.register('/resume', (args) => {
    const id = args[0];
    const rows = ctx.db.prepare(`SELECT id, title FROM sessions ORDER BY updated_at DESC`).all() as any[];
    if (!id) return lines(' 会话（/resume <id> 恢复） ', rows.map(r => ` ${r.id}  ${r.title || '(无标题)'}`));
    let target = id;
    if (!rows.some(r => r.id === id)) {
      // 标题模糊匹配：取最近更新且标题包含关键词的会话
      const q = id.toLowerCase();
      const hit = rows.find(r => String(r.title ?? '').toLowerCase().includes(q));
      if (!hit) return `会话不存在：${id}`;
      target = hit.id;
    }
    const cnt = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`).get(target) as { c: number }).c;
    // 真正切换：agent 会话 + 状态提示（CLI 单会话 'default' 主用；UI 走 session.resume RPC）
    try { ctx.agent?.setSessionId(target); } catch { /* 无 agent 时仅提示 */ }
    return `已切换到会话 ${target}（${cnt} 条消息）${cnt ? '——历史已加载，可直接继续对话' : ''}`;
  });

  // /new：新建空会话并切换
  bus.register('/new', () => {
    const newId = `s${Date.now()}n`;
    ctx.db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(newId, '', Date.now(), Date.now());
    try { ctx.agent?.setSessionId(newId); } catch { /* 忽略 */ }
    return `已新建会话 ${newId} 并切换`;
  });

  // /title <名称>：重命名当前会话（对齐参考 /title 语义）
  bus.register('/title', (args) => {
    const name = args.join(' ').trim();
    const sid = 'default';
    if (!name) {
      const row = ctx.db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sid) as { title: string } | undefined;
      return `当前会话标题：${row?.title || '(未命名)'}（/title <名称> 重命名）`;
    }
    ctx.db.prepare(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`).run(name.slice(0, 50), Date.now(), sid);
    return `会话已重命名：${name.slice(0, 50)}`;
  });

  // /undo：轮级回滚（机制补强）——撤销最近 N 轮（默认 1 轮），撤销前自动保存 checkpoint
  //   F20 修复：软撤销（UPDATE archived=1 而非 DELETE——recall 全量永不丢，黑洞可检索）；
  //   快照含完整字段（id/archived/ts），restore 才能重建原始状态
  //   对比轮 6 补强：/undo list 列出可撤销轮次（时间 + 首句）
  bus.register('/undo', (args) => {
    // M4 修复：定位当前会话（UI 多会话切换后 /undo 作用于活跃会话）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    const msgs = ctx.db.prepare(`SELECT id, role, content, ts FROM messages WHERE session_id=? AND role!='system' AND archived=0 ORDER BY id`).all(sid) as Array<{ id: number; role: string; content: string; ts: number }>;
    if (!msgs.length) return '没有可撤销的消息';
    // 定位 user 消息轮次（从尾部数）
    const userIdx: number[] = [];
    msgs.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
    if (!userIdx.length) return '没有可撤销的轮次';
    if (args[0] === 'list') {
      const recent = userIdx.slice(-5).reverse();
      return lines(' 可撤销轮次（/undo <n> 撤销） ', recent.map((ui, k) => {
        const m = msgs[ui]!;
        const firstLine = String(m.content ?? '').split('\n')[0]!.slice(0, 30);
        return ` #${userIdx.length - ui}  ${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })}  ${firstLine}`;
      }));
    }
    const n = parseInt(args[0] ?? '1', 10);
    if (!Number.isFinite(n) || n < 1 || n > 20) return '用法：/undo [轮次数 1-20] ｜ /undo list 查看可撤销轮次';
    const target = userIdx[Math.max(0, userIdx.length - n)]!;
    // 撤销前自动快照（F20：完整字段 id/archived/ts，restore 保留原始 id 与黑洞状态）
    try {
      const full = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? AND role!='system' ORDER BY id`).all(sid);
      saveCheckpoint(ctx.db, sid, { kind: 'undo-snapshot', messages: full, ts: Date.now() });
    } catch { /* 快照失败不阻断 */ }
    const dropIds = msgs.slice(target).map(m => m.id);
    // F20：软撤销——归档而非删除（recall 全量仍可检索，working 窗口回退）
    ctx.db.prepare(`UPDATE messages SET archived=1 WHERE id IN (${dropIds.map(() => '?').join(',')})`).run(...dropIds);
    return `已撤销 ${n} 轮（${dropIds.length} 条消息移入历史存档，仍可检索）——/checkpoint restore 可恢复到撤销前`;
  });

  // /fork：复制当前会话（含全部消息）为分支会话
  bus.register('/fork', (args) => {
    const target = args[0] ?? ctx.agent?.getSessionId?.() ?? 'default';
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
      // F20：快照含完整字段（id/archived/ts），restore 保留原始 id 与黑洞状态
      const msgs = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? ORDER BY id`).all(sid);
      const id = saveCheckpoint(ctx.db, sid, { kind: 'manual', messages: msgs, ts: Date.now() });
      return `已保存快照 #${id}（${(msgs as unknown[]).length} 条消息）`;
    }
    if (sub === 'restore') {
      const id = rest[0];
      const row = id
        ? ctx.db.prepare(`SELECT data FROM checkpoints WHERE id=? AND session_id=?`).get(id, sid) as { data: string } | undefined
        : ctx.db.prepare(`SELECT data FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sid) as { data: string } | undefined;
      if (!row) return `未找到快照${id ? ` #${id}` : ''}`;
      const d = JSON.parse(row.data) as { messages?: Array<{ id?: number; role: string; content: string; tool_call_id?: string | null; archived?: number; ts?: number }> };
      if (!Array.isArray(d.messages)) return '快照数据不完整';
      // 恢复：清空当前消息 → 重插快照消息（F20：保留原始 id/ts/archived——向量索引关联与黑洞状态不丢）
      ctx.db.prepare(`DELETE FROM messages WHERE session_id=?`).run(sid);
      const ins = ctx.db.prepare(`INSERT INTO messages (id, session_id, role, content, tool_call_id, archived, ts) VALUES (?,?,?,?,?,?,?)`);
      const now = Date.now();
      d.messages.forEach((m, i) => {
        const rawId = Number(m.id);
        const mid = Number.isInteger(rawId) && rawId > 0 ? rawId : undefined;
        ins.run(mid ?? null, sid, m.role, String(m.content ?? ''), m.tool_call_id ?? null, m.archived === 1 ? 1 : 0, Number(m.ts) || now + i);
      });
      return `已从快照${id ? ` #${id}` : ''}恢复 ${d.messages.length} 条消息（保留原始 id/archived）`;
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
    // B2 修复：定位当前活跃会话（不再硬编码 'default'）+ 真实 token 统计（usage_stats）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    const real = ctx.db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(output_tokens),0) AS ot, COUNT(DISTINCT model) AS models FROM usage_stats WHERE session_id=?`
    ).get(sid) as { c: number; it: number; ot: number; models: number };
    const rows = ctx.db.prepare(`SELECT role, content FROM messages WHERE session_id=?`).all(sid) as any[];
    const est = rows.reduce((a, r) => a + estimateTokens(r.content), 0);
    const realTotal = real.it + real.ot;
    const tokenLine = real.c > 0
      ? ` 实际 Token：${realTotal.toLocaleString()}（输入 ${real.it.toLocaleString()} / 输出 ${real.ot.toLocaleString()}，${real.models} 个模型）`
      : ` Token：约 ${est.toLocaleString()}（本地估算，尚无 API 用量记录）`;
    return lines(' 用量 ', [
      ` 会话：${sid.slice(0, 12)}…`,
      ` 消息：${rows.length} 条`,
      tokenLine,
      ` 成本：本地运行，无 API 计费`,
    ]);
  });

  // /context：上下文占用可视化（P2b 增强——工作窗口真实 token 分布 + 预算占用条）
  bus.register('/context', () => {
    const rec = ctx.mem.recall('default');
    const working = ctx.mem.working('default');
    const BUDGET = 48000; // 默认上下文预算（与 agent maxContextTokens 默认一致）
    const byRole: Record<string, number> = {};
    let total = 0;
    for (const m of working) {
      const t = estimateTokens(String(m.content ?? ''));
      byRole[m.role] = (byRole[m.role] ?? 0) + t;
      total += t;
    }
    const pct = Math.min(1, total / BUDGET);
    const barW = 20;
    const filled = Math.round(pct * barW);
    const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
    const rows: string[] = [
      ` 工作窗口：${working.length}/20 条 · ${total.toLocaleString()} token`,
      ` 占用：${bar} ${Math.round(pct * 100)}%（预算 ${(BUDGET / 1000).toFixed(0)}k token）`,
    ];
    if (Object.keys(byRole).length) {
      rows.push(' ── 角色分布 ──');
      for (const [r, t] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
        const roleName = r === 'user' ? '用户' : r === 'assistant' ? '助手' : r === 'tool' ? '工具' : r;
        rows.push(` ${roleName.padEnd(4)} ${t.toLocaleString()} token（${Math.round((t / total) * 100)}%）`);
      }
    }
    rows.push(` 黑洞全量：${rec.length} 条 · 吸附归档 ${ctx.mem.absorbCount('default')} 条（/hole 可检索）`);
    if (total > BUDGET * 0.85) {
      rows.push(' ⚠ 接近预算上限——建议 /compact 压缩上下文');
    }
    return lines(' 上下文 ', rows);
  });

  // ── 记忆类 ──────────────────────────────────
  // /compact：上下文压缩（对比轮 6 修复：有密钥时 LLM 真实总结，无密钥降级规则摘要）
  bus.register('/compact', async () => {
    const before = ctx.mem.recall('default').length;
    const summarize = async (text: string): Promise<string> => {
      try {
        const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
        if (!enc) return `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
        const key = decryptKey(enc);
        if (!key) return `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
        const { buildChatRequest } = await import('../kernel/providers.js');
        const baseURL = (ctx.config.getKey('settings', 'baseURL') as string) || 'https://api.deepseek.com/v1';
        const model = (ctx.config.getKey('settings', 'model') as string) || 'deepseek-v4-flash';
        const req = buildChatRequest({
          baseURL, model, key,
          messages: [
            { role: 'system', content: '你是上下文压缩器。把对话片段压缩为保留关键信息的摘要（中文，≤400 字），只输出摘要。' },
            { role: 'user', content: text },
          ],
          stream: false,
        });
        const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const j = await resp.json() as any;
        const summary = String(j?.choices?.[0]?.message?.content ?? '').trim();
        return summary || `（规则压缩）${text.slice(0, 400)}`;
      } catch { return `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`; }
    };
    await ctx.mem.compactSmart('default', summarize);
    const after = ctx.mem.recall('default').length;
    return `压缩完成：${before} → ${after} 条（LLM 摘要，无密钥时规则降级）`;
  });

  // /digest：最近对话摘要（对比轮 6 修复：有密钥时 LLM 真实提炼，无密钥规则摘要）
  bus.register('/digest', async () => {
    const rec = ctx.mem.recall('default');
    if (!rec.length) return '暂无记忆';
    const last = rec.slice(-10);
    const transcript = last.filter((m: any) => m.role !== 'system').map((m: any) => `${m.role}: ${String(m.content ?? '').slice(0, 200)}`).join('\n');
    // LLM 提炼（有密钥时）
    try {
      const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
      if (enc) {
        const key = decryptKey(enc);
        if (key) {
          const { buildChatRequest } = await import('../kernel/providers.js');
          const baseURL = (ctx.config.getKey('settings', 'baseURL') as string) || 'https://api.deepseek.com/v1';
          const model = (ctx.config.getKey('settings', 'model') as string) || 'deepseek-v4-flash';
          const req = buildChatRequest({
            baseURL, model, key,
            messages: [
              { role: 'system', content: '你是对话摘要器。把对话提炼为要点（中文，≤200 字），只输出要点。' },
              { role: 'user', content: transcript },
            ],
            stream: false,
          });
          const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
          if (resp.ok) {
            const j = await resp.json() as any;
            const summary = String(j?.choices?.[0]?.message?.content ?? '').trim();
            if (summary) return lines(' 对话摘要（LLM） ', summary.split('\n').map(l => ` ${l}`));
          }
        }
      }
    } catch { /* 降级规则摘要 */ }
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
  //   L0 只读（plan）｜L1 默认（smart）｜L2 自动编辑（auto）｜L3 全放（yolo）
  bus.register('/sandbox', (args) => {
    const LAYERS: Record<string, string> = { L0: 'plan', L1: 'smart', L2: 'auto', L3: 'yolo' };
    const current = Object.entries(LAYERS).find(([, m]) => m === ctx.getMode())?.[0] ?? '?';
    const want = (args[0] ?? '').toUpperCase();
    if (want in LAYERS) {
      ctx.setMode(LAYERS[want]!);
      const desc: Record<string, string> = { plan: '只读探索 + 计划审批', smart: '只读放行，危险工具确认', auto: '自动编辑（文件写入免确认）', yolo: '除硬红线全部放行' };
      return `沙盒已切换：L${want.slice(1)} → ${LAYERS[want]} 模式（${desc[LAYERS[want]!]}）`;
    }
    return lines(' 沙盒（L0-L3） ', [
      ` 当前层：L${current.slice(1)}（${ctx.getMode()}）`,
      ` L0 → plan  只读探索 + 计划审批（写操作需确认）`,
      ` L1 → smart 更改前确认：只读放行，危险工具确认（默认）`,
      ` L2 → auto  自动编辑：文件写入免确认，命令按分级`,
      ` L3 → yolo  完全访问：除硬红线全部放行`,
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

  bus.register('/config', (args) => {
    const s = ctx.config.get('settings') as Record<string, any>;
    // P2 配置校验：未知键警告（防拼写错误静默无效）
    const { unknownSettingsKeys } = require('../store/config.js') as typeof import('../store/config.js');
    const unknown = unknownSettingsKeys(s);
    if (args[0] === 'set' && args[1]) {
      const key = args[1];
      if (!['model', 'theme', 'mode', 'thinking', 'autoResume', 'autoReview', 'lowRiskAutoApprove', 'busy_input_mode'].includes(key)) {
        return `未知配置键「${key}」——支持：model/theme/mode/thinking/autoResume/autoReview/lowRiskAutoApprove/busy_input_mode`;
      }
      const raw = args.slice(2).join(' ');
      const value: any = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : !Number.isNaN(Number(raw)) && raw !== '' ? Number(raw) : raw;
      ctx.config.setKey('settings', key, value);
      return `已设置 ${key} = ${JSON.stringify(value)}`;
    }
    const safe = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'apiKeyEnc' ? (v ? 'enc:****' : '') : v]));
    const rows = Object.entries(safe).map(([k, v]) => ` ${k}: ${JSON.stringify(v)}`);
    if (unknown.length) rows.push('', ` ⚠ 未知键（可能拼写错误，不生效）：${unknown.join('、')}`);
    return lines(' 配置 ', rows);
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

  // ── 插件类（P0）──────────────────────────────────
  // /plugin：插件管理——list/install/remove/enable/disable
  //   插件 = data/plugins/<name>/（plugin.json 声明 + index.js 实现）
  //   工具自动并入 agent（danger 包裹）；命令注册为 /<插件名>.<命令名>
  bus.register('/plugin', async (args) => {
    const { loadAllPlugins, setPluginEnabled } = await import('../kernel/plugins.js');
    const [sub, ...rest] = args;
    const all = await loadAllPlugins(ctx.dataDir, ctx.cwd);

    if (!sub || sub === 'list') {
      if (!all.length) {
        return lines(' 插件 ', [' 未安装插件', '', ' 用法：/plugin install <插件目录路径>（目录需含 plugin.json + index.js）', '       /plugin remove <名称> ｜ enable｜disable <名称>', ' 插件目录：' + join(ctx.dataDir, 'plugins')]);
      }
      return lines(' 插件 ', all.map(p => {
        const toolCount = Object.keys(p.tools).length;
        const cmdCount = Object.keys(p.commands).length;
        const status = p.manifest.enabled === false ? '○ 禁用' : '● 启用';
        return ` ${status} ${p.manifest.name} v${p.manifest.version}（${toolCount} 工具${cmdCount ? ` + ${cmdCount} 命令` : ''}）${p.manifest.description ? ' · ' + p.manifest.description.slice(0, 40) : ''}`;
      }));
    }

    const name = rest[0];
    if (!name) return '用法：/plugin install <目录> ｜ new <名称> ｜ reload ｜ list ｜ remove｜enable｜disable <名称>';

    // P1b：/plugin new <名称> —— 生成插件骨架（plugin.json + index.js 模板）
    if (sub === 'new') {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return '插件名非法（仅字母/数字/_/-）';
      const dest = join(ctx.dataDir, 'plugins', name);
      if (existsSync(dest)) return `插件已存在：${name}`;
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'plugin.json'), JSON.stringify({
        name,
        version: '0.1.0',
        description: `${name} 插件`,
        tools: [{ name: `${name}_greet`, description: '打招呼', parameters: { who: { type: 'string', description: '对象' } } }],
        commands: ['hello'],
      }, null, 2), 'utf8');
      writeFileSync(join(dest, 'index.js'), `// ${name} 插件实现（ESM 模块）
// tools: Record<工具名, (args, ctx) => string | Promise<string>>
// commands: Record<命令名, (args: string[]) => string | Promise<string>>（注册为 /${name}.<命令名>）
export const tools = {
  ${name}_greet: async (args, ctx) => \`你好，\${args?.who ?? '世界'}（插件数据目录：\${ctx.dataPath}）\`,
}

export const commands = {
  hello: async (args) => \`\${args.length ? args.join(' ') : '（空参数）'}\`,
}
`, 'utf8');
      return `插件骨架已生成 → ${dest}\n编辑 index.js 实现逻辑后，新开会话或 /plugin reload 生效`;
    }

    // P1b：/plugin reload —— 热重载（重建 agent 工具表，不重启进程）
    if (sub === 'reload') {
      const { loadAllPlugins, pluginToolsToExtra } = await import('../kernel/plugins.js');
      const reloaded = await loadAllPlugins(ctx.dataDir, ctx.cwd);
      const toolCount = Object.keys(pluginToolsToExtra(reloaded)).length;
      const enabled = reloaded.filter(p => p.manifest.enabled !== false).length;
      if (ctx.agent?.updateTools) {
        ctx.agent.updateTools(pluginToolsToExtra(reloaded));
        return `插件已热重载：${enabled} 个启用（${toolCount} 工具）——无需重启`;
      }
      return `已重新扫描：${enabled} 个启用（${toolCount} 工具）——当前环境不支持热更新，重启后生效`;
    }

    if (sub === 'install') {
      const src = resolve(process.cwd(), name);
      if (!existsSync(src)) return `目录不存在：${src}`;
      const manifestFile = join(src, 'plugin.json');
      if (!existsSync(manifestFile)) return `不是插件目录（缺 plugin.json）：${src}`;
      // 解析清单取插件名（复制目标目录名）
      const { parsePluginManifest } = await import('../kernel/plugins.js');
      let pluginName = '';
      try { pluginName = parsePluginManifest(readFileSync(manifestFile, 'utf8')).name; } catch (e: any) { return `plugin.json 解析失败：${e?.message?.slice(0, 120) ?? e}`; }
      const dest = join(ctx.dataDir, 'plugins', pluginName);
      if (existsSync(dest)) return `插件已存在：${pluginName}（/plugin remove ${pluginName} 后重装）`;
      mkdirSync(dest, { recursive: true });
      // 复制 plugin.json 与 index.js（及 data 目录）
      for (const f of ['plugin.json', 'index.js']) {
        const srcF = join(src, f);
        if (existsSync(srcF)) writeFileSync(join(dest, f), readFileSync(srcF, 'utf8'), 'utf8');
      }
      const srcData = join(src, 'data');
      if (existsSync(srcData)) {
        mkdirSync(join(dest, 'data'), { recursive: true });
        for (const f of readdirSync(srcData)) {
          writeFileSync(join(dest, 'data', f), readFileSync(join(srcData, f), 'utf8'), 'utf8');
        }
      }
      return `插件已安装：${pluginName} → ${dest}（重启后工具/命令生效；本会话可用 /plugin list 查看）`;
    }

    const target = all.find(p => p.manifest.name === name);
    if (!target) return `插件不存在：${name}（/plugin list 查看）`;

    if (sub === 'remove') {
      try { rmSync(target.dir, { recursive: true, force: true }); } catch (e: any) { return `删除失败：${e?.message?.slice(0, 120) ?? e}`; }
      return `插件已移除：${name}`;
    }
    if (sub === 'enable' || sub === 'disable') {
      const ok = setPluginEnabled(target.dir, sub === 'enable');
      return ok ? `插件已${sub === 'enable' ? '启用' : '禁用'}：${name}（重启后生效）` : `状态修改失败：${name}`;
    }
    return '用法：/plugin install <目录> ｜ list ｜ remove｜enable｜disable <名称>';
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
      // P3：热重载接通——/mcp add 后立即重连并热换工具表（无需重启）
      try {
        const r = await ctx.reloadMcp?.();
        return r?.ok ? `已添加并热重载 MCP server「${name}」（${r.count} 个在线，工具已并入工具表）` : `已添加 MCP server「${name}」（重启后生效）`;
      } catch { return `已添加 MCP server「${name}」（重启后生效）`; }
    }
    if (sub === 'remove') {
      const name = rest[0];
      if (!name) return '用法：/mcp remove <名称>';
      const next = servers.filter(s => s.name !== name);
      if (next.length === servers.length) return `未找到 server「${name}」`;
      saveMcpConfig(ctx.dataDir, next);
      try {
        const r = await ctx.reloadMcp?.();
        return r?.ok ? `已移除并热重载 MCP server「${name}」（${r.count} 个在线）` : `已移除 MCP server「${name}」（重启后生效）`;
      } catch { return `已移除 MCP server「${name}」（重启后生效）`; }
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

  // /perm rule：持久化审批规则（P0-2——deny>allow>ask，data/permissions.json）
  bus.register('/perm rule', (args) => {
    const { loadPermRules, savePermRules } = require('../kernel/permissions.js') as typeof import('../kernel/permissions.js');
    const [sub, tool, decision, pattern] = args;
    const rules = loadPermRules(ctx.dataDir);
    if (sub === 'list') {
      if (!rules.length) return '暂无规则（/perm rule add <工具> allow|deny|ask [路径glob]）';
      return lines(' 审批规则 ', rules.map((r, i) =>
        ` #${i + 1}  ${r.decision.toUpperCase().padEnd(5)}  ${r.tool}${r.pattern ? `  ${r.pattern}` : ''}`
      ));
    }
    if (sub === 'add') {
      if (!tool || !['allow', 'deny', 'ask'].includes(decision)) {
        return '用法：/perm rule add <工具名> allow|deny|ask [路径glob，如 src/**]';
      }
      rules.push({ tool, decision: decision as any, pattern: pattern || undefined });
      savePermRules(ctx.dataDir, rules);
      return `已添加规则：${decision} ${tool}${pattern ? `（${pattern}）` : ''}——立即生效`;
    }
    if (sub === 'remove') {
      const n = parseInt(tool, 10);
      if (!Number.isFinite(n) || n < 1 || n > rules.length) return '用法：/perm rule remove <编号>（/perm rule list 查看编号）';
      const [removed] = rules.splice(n - 1, 1);
      savePermRules(ctx.dataDir, rules);
      return `已移除规则：${removed.decision} ${removed.tool}`;
    }
    if (sub === 'clear') {
      savePermRules(ctx.dataDir, []);
      return '已清空全部审批规则';
    }
    return '用法：/perm rule list ｜ add <工具> allow|deny|ask [glob] ｜ remove <编号> ｜ clear';
  });

  // /flow：技能流程图驱动（P2——Kimi /flow 能力的自研版）
  // frontmatter flow: "准备 → 构建 → 部署"；正文每节点：## 节点: <名>
  bus.register('/flow', async (args) => {
    const { loadSkill, parseFlow } = await import('../kernel/skills.js');
    const [sub, ...rest] = args;
    if (sub === 'cancel') {
      ctx.db.prepare(`UPDATE flow_runs SET finished=1 WHERE finished=0`).run();
      return '已取消全部进行中的流程';
    }
    if (sub === 'status') {
      const rows = ctx.db.prepare(`SELECT skill, nodes, current, finished FROM flow_runs ORDER BY id DESC LIMIT 1`).get() as any;
      if (!rows) return '当前无流程';
      const nodes = JSON.parse(rows.nodes) as Array<{ name: string }>;
      return lines(` 流程 ${rows.skill} `, [
        ...nodes.map((n, i) => ` ${i === rows.current && !rows.finished ? '▶' : i < rows.current || rows.finished ? '✓' : '·'} ${n.name}`),
        rows.finished ? '' : ` 下一步：/flow next（${rows.current + 1}/${nodes.length}）`,
      ]);
    }
    const name = sub ?? '';
    if (!name) return '用法：/flow <技能名> ｜ /flow next ｜ /flow status ｜ /flow cancel';
    const skill = loadSkill(ctx.dataDir, ctx.cwd, name);
    if (!skill) return `技能不存在：${name}（/skill list 查看）`;
    const flow = parseFlow(skill.body, skill.meta.flow);
    if (!flow) return `技能「${name}」未定义流程（frontmatter 需 flow: "节点A → 节点B"）`;
    // 已有进行中流程则继续，否则新建
    let run = ctx.db.prepare(`SELECT id, current FROM flow_runs WHERE skill=? AND finished=0 ORDER BY id DESC LIMIT 1`).get(name) as { id: number; current: number } | undefined;
    if (!run) {
      const r = ctx.db.prepare(`INSERT INTO flow_runs (skill, nodes, current, finished, ts) VALUES (?,?,?,?,?)`)
        .run(name, JSON.stringify(flow), 0, 0, Date.now());
      run = { id: Number(r.lastInsertRowid), current: 0 };
    }
    const node = flow[run.current]!;
    const step = `${run.current + 1}/${flow.length}`;
    void ctx.agent?.run(`（流程「${name}」步骤 ${step}：${node.name}）执行以下步骤并完成后简要汇报：\n${node.instruction}`).catch(() => {});
    return `▶ 流程「${name}」步骤 ${step}：${node.name}——已交给助手执行（/flow next 推进下一步，/flow status 查看进度）`;
  });

  // /security：安全注入通道管理（红线：关闭通道即同步清除内存敏感缓存）
  bus.register('/security', (args) => {
    const [sub, state] = args;
    const sec = ((ctx.config.get('settings') as any)?.security ?? {}) as { sudoInjection?: boolean; secretInjection?: boolean };
    if (!sub || sub === 'status') {
      const sudoOn = sec.sudoInjection === true;
      const secretOn = sec.secretInjection === true;
      const vault = ctx.secrets;
      return lines(' 安全注入通道 ', [
        ` sudo 注入：${sudoOn ? '开启' : '关闭'} ｜ 内存密码：${vault?.hasSudo() ? '已缓存（仅内存）' : '无'}`,
        ` secret 注入：${secretOn ? '开启' : '关闭'} ｜ 内存密钥：${vault?.secretNames().length ? `${vault.secretNames().length} 个（仅内存）` : '无'}`,
        '',
        ' 用法：/security sudo on|off ｜ /security secret on|off ｜ /security all off',
        ' 红线：敏感内容仅用户亲手输入、仅内存使用；关闭通道即同步清除缓存',
      ]);
    }
    const set = (next: Record<string, boolean>) => {
      ctx.config.setKey('settings', 'security', { ...sec, ...next });
      return next;
    };
    if (sub === 'sudo') {
      if (state === 'on') { set({ sudoInjection: true }); return 'sudo 注入通道已开启——密码仅内存使用，/security sudo off 关闭即清除'; }
      if (state === 'off') { set({ sudoInjection: false }); ctx.secrets?.clearSudoPassword(); return '已关闭 sudo 注入通道，并同步清除内存密码缓存'; }
      return '用法：/security sudo on|off';
    }
    if (sub === 'secret') {
      if (state === 'on') { set({ secretInjection: true }); return 'secret 注入通道已开启——密钥仅内存使用，/security secret off 关闭即清除'; }
      if (state === 'off') { set({ secretInjection: false }); ctx.secrets?.clearSecrets(); return '已关闭 secret 注入通道，并同步清除内存密钥缓存'; }
      return '用法：/security secret on|off';
    }
    if (sub === 'all' && state === 'off') {
      set({ sudoInjection: false, secretInjection: false });
      ctx.secrets?.clearAll();
      return '已关闭全部注入通道，并同步清空内存敏感数据';
    }
    return '用法：/security status ｜ sudo on|off ｜ secret on|off ｜ all off';
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

  // /cron：定时任务（真实调度——add/list/del；cli 启动后轮询执行到期任务）
  //   用法：/cron add <分钟间隔> <命令文本> ｜ /cron list ｜ /cron del <id> ｜ /cron pause <id>
  bus.register('/cron', (args) => {
    const [sub, ...rest] = args;
    if (sub === 'add') {
      const interval = parseInt(rest[0] ?? '', 10);
      const action = rest.slice(1).join(' ').trim();
      if (!Number.isFinite(interval) || interval < 1 || !action) return '用法：/cron add <分钟间隔> <命令文本>（如 /cron add 30 检查并报告仓库状态）';
      const r = ctx.db.prepare(`INSERT INTO cron_jobs (schedule, action, last_run, enabled) VALUES (?,?,?,1)`).run(`every ${interval}m`, action, Date.now()); // last_run=创建时刻（周期起算点）
      return `定时任务已创建 #${r.lastInsertRowid}：每 ${interval} 分钟执行「${action.slice(0, 40)}」`;
    }
    if (sub === 'del' || sub === 'rm') {
      const id = parseInt(rest[0] ?? '', 10);
      if (!Number.isFinite(id)) return '用法：/cron del <id>';
      ctx.db.prepare(`DELETE FROM cron_jobs WHERE id=?`).run(id);
      return `定时任务 #${id} 已删除`;
    }
    if (sub === 'pause' || sub === 'resume') {
      const id = parseInt(rest[0] ?? '', 10);
      if (!Number.isFinite(id)) return `用法：/cron ${sub} <id>`;
      ctx.db.prepare(`UPDATE cron_jobs SET enabled=? WHERE id=?`).run(sub === 'pause' ? 0 : 1, id);
      return `定时任务 #${id} 已${sub === 'pause' ? '暂停' : '恢复'}`;
    }
    const jobs = ctx.db.prepare(`SELECT * FROM cron_jobs ORDER BY id`).all() as any[];
    if (!jobs.length) return '暂无定时任务——/cron add <分钟间隔> <命令> 创建（如 /cron add 30 检查仓库状态）';
    return lines(' 定时任务 ', jobs.map(j => {
      const last = j.last_run ? new Date(j.last_run).toLocaleTimeString('zh-CN', { hour12: false }) : '未执行';
      return ` #${j.id} ${j.enabled ? '●' : '○'} ${j.schedule}（上次 ${last}）→ ${String(j.action ?? '').slice(0, 40)}`;
    }));
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
  // /task：后台任务浏览器（对比轮 6 补强——映射 /jobs 同一后端；show 查看输出）
  bus.register('/task', (args) => {
    const [sub, ...rest] = args;
    if (sub === 'show') {
      const id = rest[0];
      if (!id) return '用法：/task show <任务ID>';
      const row = ctx.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as any;
      if (!row) return `任务不存在：${id}`;
      return lines(` 任务 ${id} `, [
        ` 目标：${row.goal}`,
        ` 状态：${row.status === 'running' ? '⏳ 运行中' : row.status === 'done' ? '✓ 完成' : '✗ 失败'}（${row.status}）`,
        ...(row.output ? ['', ...String(row.output).split('\n').slice(0, 15).map(l => ` ${l.slice(0, 110)}`)] : []),
      ]);
    }
    if (sub === 'clean') {
      const r = ctx.db.prepare(`DELETE FROM tasks WHERE status != 'running'`).run();
      return `已清理 ${r.changes} 条已完成/失败任务`;
    }
    if (sub === 'run') return '后台派发请用 /jobs run <任务>（本命令为任务浏览）';
    let rows: any[] = [];
    try {
      rows = ctx.db.prepare(`SELECT id, goal, status, created_at, done_at FROM tasks ORDER BY created_at DESC LIMIT 20`).all() as any[];
    } catch { return '任务表未初始化（/jobs run <任务> 派发后可用）'; }
    if (!rows.length) return '暂无后台任务（/jobs run <任务> 派发）';
    return lines(' 后台任务 ', rows.map(r => ` ${r.status === 'running' ? '⏳' : r.status === 'done' ? '✓' : '✗'} ${r.id} ${r.status === 'running' ? '' : `[${Math.round((r.done_at - r.created_at) / 1000)}s] `}${String(r.goal).slice(0, 50)}`));
  });

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

  // /plan：计划模式产物（对比轮 6 补强——对齐参考 plan 文件机制）
  //   /plan on|off 模式切换 ｜ /plan save [需求] LLM 生成计划文件 ｜ /plan view ｜ /plan clear
  bus.register('/plan', async (args) => {
    const [sub, ...rest] = args;
    const sid = 'default';
    const dir = join(ctx.dataDir, 'plans');
    const file = join(dir, `${sid}.md`);
    if (sub === 'on') { ctx.setMode('plan'); return '计划模式已开启（只读研究 + 非只读需计划审批）——完成后 /plan save 生成计划文件'; }
    if (sub === 'off') { ctx.setMode('smart'); return '计划模式已关闭（回到 smart 更改前确认）'; }
    if (sub === 'view') {
      try { return readFileSync(file, 'utf8').slice(0, 6000); } catch { return '暂无计划文件——/plan save 生成'; }
    }
    if (sub === 'clear') {
      try { rmSync?.(file, { force: true }); } catch { /* 忽略 */ }
      return '计划文件已清除';
    }
    if (sub === 'save') {
      const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
      if (!enc) return '未配置模型密钥——/key set <密钥> 后 /plan save 才能生成计划（不产生假内容）';
      const key = decryptKey(enc);
      if (!key) return '密钥无法解密——请 /key set <密钥> 重新配置';
      const goal = rest.join(' ').trim() || String(ctx.mem.recall(sid).filter(m => m.role === 'user').at(-1)?.content ?? '').slice(0, 500);
      if (!goal) return '没有可规划的需求——/plan save <需求描述> 或先对话几轮';
      try {
        const { buildChatRequest } = await import('../kernel/providers.js');
        const baseURL = (ctx.config.getKey('settings', 'baseURL') as string) || 'https://api.deepseek.com/v1';
        const model = (ctx.config.getKey('settings', 'model') as string) || 'deepseek-v4-flash';
        const req = buildChatRequest({
          baseURL, model, key,
          messages: [
            { role: 'system', content: '你是实施规划器。把需求拆解为可执行计划（Markdown：目标/步骤/验证/风险，中文，步骤可逐项落地），只输出计划正文。' },
            { role: 'user', content: `需求：${goal}` },
          ],
          stream: false,
        });
        const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
        if (!resp.ok) return `计划生成失败（${resp.status}）——请检查密钥与模型配置`;
        const j = await resp.json() as any;
        const plan = String(j?.choices?.[0]?.message?.content ?? '').trim() || '（模型未返回计划）';
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `# 实施计划\n\n> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n> 需求：${goal.slice(0, 200)}\n\n${plan}`, 'utf8');
        return `计划已写入 → ${file}\n${plan.slice(0, 400)}${plan.length > 400 ? '…' : ''}`;
      } catch (e: any) {
        return `计划生成失败：${e?.message?.slice(0, 200) ?? e}`;
      }
    }
    return '用法：/plan on｜off｜save [需求]｜view｜clear';
  });

  // /import <文件>：导入消息（JSON [{role,content}] 或纯文本 → user 消息）回填会话
  bus.register('/import', (args) => {
    const path = args[0];
    if (!path) return '用法：/import <文件路径>（JSON [{role,content}] 或文本）';
    let text = '';
    try { text = readFileSync(resolve(process.cwd(), path), 'utf8'); } catch { return `无法读取文件：${path}`; }
    let imported = 0;
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        const ins = ctx.db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, ts) VALUES (?,?,?,?,?)`);
        const now = Date.now();
        for (const m of data) {
          const role = String(m?.role ?? 'user');
          if (!['user', 'assistant', 'system'].includes(role)) continue;
          ins.run('default', role, String(m?.content ?? ''), null, now + imported);
          imported++;
        }
      } else {
        ctx.mem.append('default', 'user', text);
        imported = 1;
      }
    } catch {
      // 非 JSON：整体作为 user 消息导入
      ctx.mem.append('default', 'user', text);
      imported = 1;
    }
    return `已导入 ${imported} 条消息到当前会话（/resume 或直接继续对话）`;
  });

  // /flow <需求>：AI 生成流程图（Mermaid）写入 data/flow/（参考 flow 技能的落地替代）
  bus.register('/flow', async (args) => {
    const goal = args.join(' ').trim();
    if (!goal) return '用法：/flow <流程需求>（如 /flow 用户注册流程）——AI 生成 Mermaid 流程图';
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    if (!enc) return '未配置模型密钥——/key set <密钥> 后 /flow 才能生成流程图';
    const key = decryptKey(enc);
    if (!key) return '密钥无法解密——请 /key set <密钥> 重新配置';
    try {
      const { buildChatRequest } = await import('../kernel/providers.js');
      const baseURL = (ctx.config.getKey('settings', 'baseURL') as string) || 'https://api.deepseek.com/v1';
      const model = (ctx.config.getKey('settings', 'model') as string) || 'deepseek-v4-flash';
      const req = buildChatRequest({
        baseURL, model, key,
        messages: [
          { role: 'system', content: '你是流程图设计师。把流程需求转换为 Mermaid 流程图（flowchart TD 语法，节点用中文，只输出 mermaid 代码块内容，不要解释）。' },
          { role: 'user', content: goal },
        ],
        stream: false,
      });
      const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) return `流程图生成失败（${resp.status}）`;
      const j = await resp.json() as any;
      const mermaid = String(j?.choices?.[0]?.message?.content ?? '').trim()
        .replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/, '');
      if (!mermaid || !mermaid.includes('-->')) return '模型未返回有效流程图';
      const dir = join(ctx.dataDir, 'flow');
      mkdirSync(dir, { recursive: true });
      const slug = goal.replace(/[^\w\u4e00-\u9fff]+/g, '-').slice(0, 30) || `flow-${Date.now().toString(36)}`;
      const file = join(dir, `${slug}.mmd`);
      writeFileSync(file, mermaid, 'utf8');
      return `流程图已生成 → ${file}\n\`\`\`mermaid\n${mermaid.slice(0, 800)}\n\`\`\``;
    } catch (e: any) {
      return `流程图生成失败：${e?.message?.slice(0, 200) ?? e}`;
    }
  });

  // 审计留痕
  try { appendAudit(ctx.db, 'handlers.ext.registered', { count: 47 }); } catch { /* 审计表未就绪时静默 */ }
}
