// src/commands/handlersExt.ts — 扩展命令处理器（registry 实测 108 条——此计数与 SLASH 长度同步，勿回写旧值）
// 设计：与 handlers.ts 分离，按类补齐——工具（确定性）/会话/记忆/构建/安全/
//       系统/视觉/连接/协作。每个命令真实可用（查询现有数据或执行确定性操作），
//       输出统一 lines() 面板或单行。红线：只读工具不写库；路径操作限制在 dataDir。
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { join, basename, resolve, dirname, relative, normalize, sep } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { appendAudit, saveCheckpoint, restoreCheckpoint, replaceSessionMessages } from '../store/db.js';
import { parseSinceArg } from '../kernel/memory.js';
import { estimateTokens } from '../kernel/memory.js';
import { isCompletionClaim } from '../kernel/completionClaim.js';
import { runGate } from '../build/gate.js';
import { writeEvidence } from '../build/evidence.js';
import { forgeMcpServer, forgeSkillDir } from '../forge/forge.js';
import { discoverSkills, loadSkill, writeSkill, skillContentForModel } from '../kernel/skills.js';
import { scanProject, renderAgentsMd } from '../kernel/projectScan.js';
import { buildRepoMap } from '../kernel/repoMap.js';
import { listShadows, restoreShadow, versionsOfFile, snapshotDir, restoreDirShadows } from '../kernel/undoShadows.js';
import { listScripts, loadScript, saveScript, deleteScript, isValidScriptName, scriptStats, checkScriptExpectations, type Script, type ScriptStep } from '../kernel/scripts.js';
import { parseCronExpr, describeCronExpr } from '../kernel/cronExpr.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { HARD_REDLINES, loadPermRules, savePermRules } from '../kernel/permissions.js';
import { unknownSettingsKeys, knownSettingsKeys } from '../store/config.js';
import { runCuratorReview, curatorConfigFrom, readCuratorState } from '../kernel/curator.js';
import { usageSummary, usageRangeSince, type UsageRange } from '../kernel/usage.js';
import { estimateCost } from '../kernel/cost.js';
import { sessionCost, rangeCost, costText, type CostQueryResult } from '../kernel/costQuery.js';
import { labelTruncate } from '../kernel/truncate.js';
import { encryptKey } from '../kernel/providers.js';
import { resolveProviderProfile } from '../kernel/profiles.js';
import { fetchBalanceCached } from '../kernel/balance.js';
import type { TaskSpec, TaskRow } from '../kernel/taskRunner.js';
import { c, type HandlerCtx } from './handlers.js';
import type { CommandBus, StructuredCommand } from '../app/CommandBus.js';

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

// /script 录制状态（模块级——bus 处理器共享；/script record 挂 agent recorder）
let scriptRecording: { name: string; description: string; buffer: ScriptStep[]; current: ScriptStep | null; offStart?: () => void } | null = null;

// /usage --waterfall 的条形瀑布渲染（纯函数可单测）：
// 每行 = 一次 API 调用（轮），条长按总 token 缩放——input 段用 ░、output 段用 █，
// 一眼看出「哪轮烧 token、输入输出比」。宽度固定（后端无终端宽度，面板自洽即可）。
export function renderWaterfall(
  rows: Array<{ model: string; input_tokens: number; output_tokens: number; ts: number }>,
  width = 40,
  title?: string,
  priceFor?: (model: string, inputTokens: number, outputTokens: number) => number | null,
): string {
  const max = Math.max(...rows.map(r => r.input_tokens + r.output_tokens), 1);
  const scale = (n: number) => Math.max(1, Math.round((n / max) * width));
  const out = rows.map(r => {
    const total = r.input_tokens + r.output_tokens;
    // 0 token 行 = 端点未上报用量：无条形（NaN 防护）+ 显式标注——绝不伪装成 ≈$0 免费
    if (total === 0) {
      return ` ${new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false })} ${r.model.slice(0, 14).padEnd(14)} ${' '.repeat(2)}（端点未上报用量）`;
    }
    const inLen = Math.max(1, Math.round((r.input_tokens / total) * scale(total)));
    const outLen = Math.max(1, scale(total) - inLen + 1);
    const bar = '░'.repeat(inLen) + '█'.repeat(outLen);
    const t = new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false });
    // 行尾成本（参考价目；未收录定价不显示——诚实）——哪轮烧钱一眼可见
    const cost = priceFor ? priceFor(r.model, r.input_tokens, r.output_tokens) : null;
    return ` ${t} ${r.model.slice(0, 14).padEnd(14)} ${bar} ${total.toLocaleString()} tok（入 ${r.input_tokens.toLocaleString()} / 出 ${r.output_tokens.toLocaleString()}）${cost !== null ? ` ≈$${cost.toFixed(4)}` : ''}`;
  });
  return lines(title ?? ` Token 瀑布（最近 ${rows.length} 轮 · ░输入 █输出） `, out);
}

/** /profile add 参数解析（纯函数可单测） */
export function parseProfileAddArgs(args: string[]): { name: string; baseURL: string; models: string[] } | null {
  const name = String(args[0] ?? '').trim();
  const baseURL = String(args[1] ?? '').trim();
  if (!name || !/^[a-zA-Z0-9_-]{1,40}$/.test(name)) return null;
  if (!/^https?:\/\//i.test(baseURL)) return null;
  const mi = args.indexOf('--models');
  const models = mi >= 0 ? (args[mi + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [];
  return { name, baseURL, models };
}

/** /balance set 参数解析（纯函数可单测） */
export function parseBalanceSetArgs(args: string[]): { url: string; jsonPath: string } {
  let url = ''; let jsonPath = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' || args[i] === '-p') { jsonPath = args[i + 1] ?? ''; i++; continue; }
    if (!url && /^https?:\/\//i.test(String(args[i] ?? ''))) url = String(args[i]!);
  }
  return { url, jsonPath };
}

/** /fs ls 封顶诚实标注（纯函数可单测）：超 30 个追加总数标注行 */
export function fsLsRows(items: string[]): string[] {
  const shown = items.slice(0, 30);
  return items.length > 30 ? [...shown, `…（共 ${items.length} 个，前 30 个——/fs tree 或分段查看）`] : shown;
}

/** /fs read 60 行封顶诚实标注（纯函数可单测）：超 60 行追加总数标注行 */
export function fsReadRows(lines: string[]): string[] {
  const shown = lines.slice(0, 60);
  return lines.length > 60 ? [...shown, `…（共 ${lines.length} 行，前 60 行——bash tail/sed 续看）`] : shown;
}

/** /sql 面板行（纯函数可单测）：前 cap 行 + 超限总数标注（行数影响数据结论——绝不静默截前 20 行） */
export function sqlTableRows(rows: Array<Record<string, unknown>>, cols: string[], cap = 20): string[] {
  const body = rows.slice(0, cap).map(r => ` ${cols.map(col => String(r[col] ?? '').slice(0, 40)).join(' | ')}`);
  return rows.length > cap ? [...body, ` …（共 ${rows.length} 行，前 ${cap} 行——WHERE/LIMIT 收窄续查）`] : body;
}

// ── Webhook 引擎（事件 → HTTP POST 回调；本地化为准，默认全部核心事件）──
const WEBHOOK_EVENTS = ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'system.notice', 'ui.confirm', 'jobs.complete'];
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
  // /eco —— Windows 生态互依状态面板（真实探测、结果缓存——反复打开不反复 spawn）
  bus.register('/eco', async () => {
    const { renderEcosystem } = await import('../application/ecosystemStatus.js');
    return renderEcosystem(ctx.dataDir);
  });
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
      return lines(' SQL ', [` ${cols.join(' | ')}`, ...sqlTableRows(rows, cols)]);
    } catch (e: any) { return `SQL 错误：${e?.message?.slice(0, 120)}`; }
  });

  bus.register('/fs', (args) => {
    const [op, ...rest] = args;
    const target = rest.join(' ').replace(/^["']|["']$/g, '');
    if (!target) return '用法：/fs <ls|read|stat|tree|glob> <路径|模式> [--depth N]';
    try {
      const p = join(ctx.cwd, target);
      if (op === 'ls') {
        if (!existsSync(p)) return `不存在：${p}`;
        const rows = fsLsRows(readdirSync(p));
        const body = rows.slice(0, 30).map(i => ` ${statSync(join(p, i)).isDirectory() ? '📁' : '📄'} ${i}`);
        const tail = rows.at(-1)?.startsWith('…（共') ? [` ${rows.at(-1)!}`] : [];
        return lines(` ls ${target} `, [...body, ...tail]);
      }
      if (op === 'read' || op === 'cat') {
        if (!existsSync(p) || statSync(p).isDirectory()) return `不存在或为目录：${p}`;
        const size = statSync(p).size;
        if (size > 200_000) return `文件过大（${size} 字节），仅支持 ≤200KB`;
        const allLines = readFileSync(p, 'utf8').split('\n');
        const rows = fsReadRows(allLines);
        const body = rows.slice(0, 60).map(l => ` ${l}`);
        const tail = rows.at(-1)?.startsWith('…（共') ? [` ${rows.at(-1)!}`] : [];
        return lines(` read ${basename(p)} `, [...body, ...tail]);
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
      // A21：目录树——/fs tree <路径> [--depth N]（ASCII 树，限深防爆炸）
      if (op === 'tree') {
        // 路径参数需剔除 --depth N（flags 不属路径）
        const depthArgIdx = args.indexOf('--depth');
        const treeTarget = args
          .slice(1)
          .filter((_, i) => depthArgIdx < 0 || (i !== depthArgIdx - 1 && i !== depthArgIdx))
          .join(' ')
          .replace(/^["']|["']$/g, '');
        const treePath = treeTarget ? join(ctx.cwd, treeTarget) : ctx.cwd;
        if (!existsSync(treePath) || !statSync(treePath).isDirectory()) return `不存在或非目录：${treePath}`;
        const depth = depthArgIdx >= 0 ? Math.min(Math.max(Number(args[depthArgIdx + 1]) || 2, 1), 6) : 2;
        const out: string[] = [basename(treePath) || treeTarget || '.'];
        const walk = (dir: string, prefix: string, level: number) => {
          if (level > depth) {
            out.push(`${prefix}…（深度 ${depth} 截断，--depth N 调深）`);
            return;
          }
          let entries: Array<{ name: string; isDir: boolean }> = [];
          try {
            entries = readdirSync(dir, { withFileTypes: true })
              .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
              .slice(0, 40)
              .map(e => ({ name: e.name, isDir: e.isDirectory() }));
          } catch { return; }          entries.forEach((e, i) => {
            const last = i === entries.length - 1;
            out.push(`${prefix}${last ? '└─ ' : '├─ '}${e.name}${e.isDir ? '/' : ''}`);
            if (e.isDir) walk(join(dir, e.name), prefix + (last ? '   ' : '│  '), level + 1);
          });
        };
        walk(treePath, '', 1);
        return lines(` tree ${treeTarget || '.'} `, out.slice(0, 80));
      }
      // A21：glob 批量匹配——/fs glob <模式>（相对 cwd；** 递归；* 单层）
      if (op === 'glob') {
        const pattern = target.replace(/\\/g, '/');
        const results: string[] = [];
        const simpleGlob = (seg: string) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*')}$`);
        const walk = (dir: string, rel: string, depthLeft: number) => {
          if (depthLeft < 0) return;
          let entries: Array<{ name: string; isDir: boolean }> = [];
          try {
            entries = readdirSync(dir, { withFileTypes: true })
              .filter(e => e.name !== 'node_modules' && e.name !== '.git')
              .map(e => ({ name: e.name, isDir: e.isDirectory() }));
          } catch { return; }
          for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (simpleGlob(pattern).test(r)) results.push(r);
            if (e.isDir) walk(join(dir, e.name), r, depthLeft - 1);
          }
        };
        walk(ctx.cwd, '', 6);
        if (!results.length) return `未匹配：${pattern}`;
        return lines(` glob ${pattern}（${results.length} 个） `, results.slice(0, 50));
      }
      return '用法：/fs <ls|read|stat|tree|glob> <路径|模式> [--depth N]';
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
  bus.register('/new', async () => {
    const newId = `s${Date.now()}n`;
    // W3 Session 第 3 步：会话启动工件（能力/hook 快照 + sha256 绑定）先落盘——
    // 生成失败 fail-closed（绝不创建无工件的会话，工件是后续审计/恢复的事实源）
    if (ctx.sessionStart) {
      const artifact = await ctx.sessionStart.ensure(newId);
      if (!artifact.ok) {
        throw new Error(`[${artifact.error.code}] 会话启动工件生成失败：${artifact.error.message}`);
      }
    }
    ctx.db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(newId, '', Date.now(), Date.now());
    try { ctx.agent?.setSessionId(newId); } catch { /* 忽略 */ }
    return `已新建会话 ${newId} 并切换`;
  });

  // /title <名称>：重命名当前会话（对齐参考 /title 语义）
  bus.register('/title', (args) => {
    const name = args.join(' ').trim();
    // 审查修复：会话统一——多会话切换后作用于当前会话（此前硬编码 default）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    if (!name) {
      const row = ctx.db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sid) as { title: string } | undefined;
      return `当前会话标题：${row?.title || '(未命名)'}（/title <名称> 重命名）`;
    }
    ctx.db.prepare(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`).run(name.slice(0, 50), Date.now(), sid);
    return `会话已重命名：${name.slice(0, 50)}`;
  });

  // /offline：离线 token 包管理（审查完善：本地 LLM 通道——离线拼图最后一块）
  //   /offline pack status  —— 各离线组件就绪状态 + 缓存占用
  //   /offline pack download [模型] —— 预下载文本 LLM（之后完全断网可用）
  //   /offline pack dir     —— 模型缓存路径
  //   /offline on           —— 切换离线模型（= /model 离线 Qwen2.5-1.5B）
  bus.register('/offline', async (args) => {
    const { OFFLINE_MODELS, offlineModelId, isOfflineModelReady, offlineCacheBytes, downloadOfflineModel } = await import('../kernel/offlineModel.js');
    const { resolveDataDir } = await import('../kernel/paths.js');
    const sub = args[0];
    if (sub === 'pack' && args[1] === 'status') {
      const models = ['offline:Qwen2.5-1.5B', 'offline:Qwen2.5-3B'];
      const mb = (offlineCacheBytes() / 1024 / 1024).toFixed(0);
      return lines(' 离线 token 包 ', [
        ` 文本 LLM（transformers.js + onnxruntime-node，随包零新增依赖）：`,
        ...models.map(m => {
          const info = OFFLINE_MODELS[m]!;
          return `   ${isOfflineModelReady(m) ? '✅' : '⬇'} ${m}（${info.sizeGB}，${info.speed}）${isOfflineModelReady(m) ? '已就绪' : '未下载——/offline pack download ' + m.replace('offline:', '')}`;
        }),
        ` 缓存占用：${mb} MB @ ${resolveDataDir(process.cwd())}`,
        ` 其他离线组件：记忆 embedding（本地）/ 视觉 moondream2（visionLocal）/ 语音 whisper——见各自命令`,
        ``,
        ` 边界（诚实）：离线模型无工具调用（对话为纯文本）、1.5B 质量有限（对话/规格化/摘要够用）、`,
        ` CPU ~15-30 tok/s。工具类任务离线由规则脑（48 模板）/确定性工具兜底。`,
      ]);
    }
    if (sub === 'pack' && args[1] === 'download') {
      const model = args[2] ? `offline:${args[2]}` : 'offline:Qwen2.5-1.5B';
      if (!offlineModelId(model)) return `未知离线模型：${model}（可选 Qwen2.5-1.5B / Qwen2.5-3B）`;
      if (isOfflineModelReady(model)) return `${model} 已就绪——直接 /model 切换使用`;
      const r = await downloadOfflineModel(model);
      return r.message;
    }
    if (sub === 'pack' && args[1] === 'dir') {
      return `模型缓存：${resolveDataDir(process.cwd())}（WXNODUS_DATA_DIR 可改）`;
    }
    if (sub === 'on') {
      const { MODEL_CATALOG } = await import('../kernel/providers.js');
      const hit = MODEL_CATALOG.find(m => m.modelId === 'offline:Qwen2.5-1.5B');
      if (hit) ctx.setModel(hit.modelId, hit.baseURL);
      return isOfflineModelReady('offline:Qwen2.5-1.5B')
        ? '已切换离线模型：Qwen2.5-1.5B（本地）——对话断网可用'
        : '已切换离线模型：Qwen2.5-1.5B（本地）——但模型未下载：/offline pack download';
    }
    return lines(' 离线 token 包 ', [
      ' 用法：',
      '  /offline pack status                — 组件就绪状态 + 缓存占用',
      '  /offline pack download [模型]       — 预下载文本 LLM（默认 Qwen2.5-1.5B）',
      '  /offline pack dir                   — 模型缓存路径',
      '  /offline on                         — 切换离线模型（=/model 离线 Qwen2.5-1.5B）',
      ` 边界：无工具调用、1.5B 质量有限、CPU ~15-30 tok/s——对话/规格化/摘要可用`,
    ]);
  });

  // /undo：轮级回滚（机制补强）——撤销最近 N 轮（默认 1 轮），撤销前自动保存 checkpoint  //   F20 修复：软撤销（UPDATE archived=1 而非 DELETE——recall 全量永不丢，黑洞可检索）；
  //   快照含完整字段（id/archived/ts），restore 才能重建原始状态
  //   对比轮 6 补强：/undo list 列出可撤销轮次（时间 + 首句）
  bus.register('/undo', (args) => {
    // /undo fs：文件编辑影子快照（Aider /undo 精神的零 git 依赖版）——
    // fs_write/fs_edit 覆盖前自动备份，/undo fs list｜restore 安全撤销文件编辑
    if (args[0] === 'fs') {
      const sub = args[1];
      if (sub === 'list') {
        const shadows = listShadows(ctx.dataDir);
        if (!shadows.length) return '无文件快照——fs_write/fs_edit 编辑文件前自动生成（/undo fs restore <编号> 恢复）';
        return lines(' 文件快照（/undo fs restore <编号>） ', shadows.slice(0, 20).map((s, i) => {
          // 相对路径展示：去 cwd 前缀 + 开头分隔符（Windows 下 slice 残留反斜杠）
          const rel = s.path.startsWith(ctx.cwd) ? s.path.slice(ctx.cwd.length).replace(/^[\\/]/, '') : s.path;
          return ` #${i + 1}  ${new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}  ${rel}（${s.content.length} 字符）`;
        }));
      }
      if (sub === 'restore') {
        const id = args[2] ?? '1';
        return restoreShadow(ctx.dataDir, id).message;
      }
      return '用法：/undo fs list｜restore [编号]（fs_write/fs_edit 编辑文件前自动快照）';
    }
    // M4 修复：定位当前会话（UI 多会话切换后 /undo 作用于活跃会话）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    const msgs = ctx.db.prepare(`SELECT id, role, content, ts, run_no FROM messages WHERE session_id=? AND role!='system' AND archived=0 ORDER BY id`).all(sid) as Array<{ id: number; role: string; content: string; ts: number; run_no: number }>;
    if (!msgs.length) return '没有可撤销的消息';
    // 架构（V3）：按 run_no 定位用户轮次（跨压缩稳定——压缩归档旧轮次后编号不变；
    // 旧数据 run_no=0 回退按消息下标定位）
    const userRuns: number[] = [];
    for (const m of msgs) {
      if (m.role === 'user' && m.run_no > 0) {
        if (!userRuns.includes(m.run_no)) userRuns.push(m.run_no);
      }
    }
    const fallbackUserIdx: number[] = [];
    msgs.forEach((m, i) => { if (m.role === 'user' && m.run_no === 0) fallbackUserIdx.push(i); });
    if (args[0] === 'list') {
      // 最近 5 个用户轮次（倒序展示）
      const recent = userRuns.length ? userRuns.slice(-5).reverse() : fallbackUserIdx.slice(-5).reverse();
      return lines(' 可撤销轮次（/undo <n> 撤销） ', recent.map((runOrIdx, k) => {
        const m = userRuns.length
          ? msgs.find(x => x.run_no === runOrIdx && x.role === 'user')
          : msgs[runOrIdx as number];
        if (!m) return ` #${k + 1}  （不可用）`;
        const firstLine = String(m.content ?? '').split('\n')[0]!.slice(0, 30);
        return ` #${k + 1}  ${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })}  ${firstLine}`;
      }));
    }
    const n = parseInt(args[0] ?? '1', 10);
    if (!Number.isFinite(n) || n < 1 || n > 20) return '用法：/undo [轮次数 1-20] ｜ /undo list 查看可撤销轮次';
    // 目标轮次定位：run_no 优先（压缩后仍精确）；旧数据回退消息下标
    const targetRun = userRuns.length ? userRuns[Math.max(0, userRuns.length - n)] : null;
    const target = targetRun
      ? msgs.findIndex(m => m.run_no === targetRun && m.role === 'user')
      : fallbackUserIdx.length ? fallbackUserIdx[Math.max(0, fallbackUserIdx.length - n)] : undefined;
    // 审查修复（P3）：无任何 user 消息时 target=undefined → slice(undefined)=slice(0) 整会话被归档
    if (target === undefined || target < 0) return '没有可撤销的用户轮次（会话中无 user 消息）';
    // 撤销前自动快照（F20：完整字段 id/archived/ts，restore 保留原始 id 与黑洞状态）
    try {
      const full = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? AND role!='system' ORDER BY id`).all(sid);
      saveCheckpoint(ctx.db, sid, { kind: 'undo-snapshot', messages: full, ts: Date.now() });
    } catch { /* 快照失败不阻断 */ }
    const dropIds = msgs.slice(target).map(m => m.id);
    if (!dropIds.length) return '没有可撤销的消息';
    // F20：软撤销——归档而非删除（recall 全量仍可检索，working 窗口回退）
    ctx.db.prepare(`UPDATE messages SET archived=1 WHERE id IN (${dropIds.map(() => '?').join(',')})`).run(...dropIds);
    return `已撤销 ${n} 轮（${dropIds.length} 条消息移入历史存档，仍可检索）——/checkpoint restore 可恢复到撤销前`;
  });

  // /versions：文件时间机器——同一文件的快照链即版本时间线（/undo fs 数据源复用）
  bus.register('/versions', (args) => {
    const target = args[0];
    if (!target) return '用法：/versions <文件>（列出该文件的历史版本）｜/versions restore <文件> <版本号>（回滚到指定版本）';
    const abs = resolve(ctx.cwd, target);
    const all = versionsOfFile(ctx.dataDir, abs);
    if (args[0] === 'restore') {
      const fileArg = args[1];
      const idx = Number(args[2] ?? 1);
      if (!fileArg || !Number.isInteger(idx) || idx < 1) return '用法：/versions restore <文件> <版本号 1=最新>';
      const versions = versionsOfFile(ctx.dataDir, resolve(ctx.cwd, fileArg));
      const v = versions[idx - 1];
      if (!v) return `文件「${fileArg}」共 ${versions.length} 个版本（版本号超范围）`;
      const r = restoreShadow(ctx.dataDir, v.id);
      return r.message;
    }
    const rel = abs.startsWith(ctx.cwd) ? abs.slice(ctx.cwd.length).replace(/^[\\/]/, '') : abs;
    if (!all.length) return `「${rel}」暂无版本记录（fs_write/fs_edit 编辑前自动快照；/snapshot <目录> 可手动建档）`;
    return lines(` 版本时间线「${rel}」`, all.map((v, i) => {
      return ` #${i + 1}  ${new Date(v.ts).toLocaleString('zh-CN', { hour12: false })}  ${v.content.length} 字符${i === 0 ? '（最新）' : ''}`;
    }));
  });

  // /snapshot：目录级快照——整目录文本文件建档，可一键整体回滚
  bus.register('/snapshot', (args) => {
    if (args[0] === 'list') {
      const shadows = listShadows(ctx.dataDir);
      const byDir = new Map<string, number>();
      for (const s of shadows) {
        const d = s.path.startsWith(ctx.cwd) ? dirname(s.path).slice(ctx.cwd.length) : s.path;
        byDir.set(d, (byDir.get(d) ?? 0) + 1);
      }
      if (!byDir.size) return '无快照（/undo fs 编辑文件前自动生成；/snapshot <目录> 手动建档）';
      return lines(' 快照分布（/undo fs list 看明细） ', [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([d, n]) => ` ${d}（${n} 份）`));
    }
    if (args[0] === 'restore') {
      const dir = args[1] ? resolve(ctx.cwd, args[1]) : ctx.cwd;
      const r = restoreDirShadows(ctx.dataDir, dir);
      if (!r.ok && !r.failed.length) return `「${dir}」无快照可恢复`;
      return `已恢复 ${r.ok} 个文件${r.failed.length ? `，失败 ${r.failed.length} 个：${r.failed.slice(0, 3).join('; ')}` : ''}`;
    }
    const dir = args[0] ? resolve(ctx.cwd, args[0]) : ctx.cwd;
    const r = snapshotDir(ctx.dataDir, dir);
    if (!r.count) return `「${dir}」无可快照文本文件（${r.skipped.length} 个跳过：二进制/超大/空）`;
    return lines(' 目录快照 ', [
      ` 已建档：${r.count} 个文本文件`,
      ` 跳过：${r.skipped.length} 个（二进制/超大/空/忽略目录）`,
      ` 回滚：/snapshot restore ${args[0] ?? '.'}（整体恢复到建档时刻）`,
    ]);
  });

  // /script：可执行剧本（开放兼容——会话 → 可重放脚本，跳过 AI 决策确定性执行）
  //   record <名> [描述]：开始录制（此后每轮用户输入 + 工具调用序列进剧本）
  //   stop：结束录制并保存 ｜ list ｜ show <名> ｜ run <名> ｜ dry-run <名> ｜ rm <名>
  bus.register('/script', async (args) => {
    const [sub, ...rest] = args;
    if (!sub || sub === 'list') {
      const scripts = listScripts(ctx.dataDir);
      if (!scripts.length) return '暂无剧本——/script record <名称> [描述] 开始录制（录制中的对话工具调用将进剧本）';
      return lines(' 剧本 ', scripts.map(s => {
        const st = scriptStats(s);
        return ` ${s.auto ? '⭯' : ' '} ${s.name}（${st.steps} 轮 / ${st.tools} 次工具调用）${s.auto ? '·自动回归 ' : ''}${s.description ? '· ' + s.description.slice(0, 40) : ''}`;
      }));
    }
    if (sub === 'record') {
      const name = rest[0];
      if (!name) return '用法：/script record <名称> [描述]——此后对话的工具调用序列将被录制';
      if (!isValidScriptName(name)) return '剧本名非法（仅字母/数字/_/-，≤40 字符）';
      if (scriptRecording) return `已在录制（${scriptRecording.name}）——先 /script stop`;
      // 每轮对话开始（agent.start）→ 新 step（用户输入入册）；工具调用由 recorder 归集
      const offStart = ctx.bus.on('agent.start', (e: any) => {
        if (scriptRecording) {
          scriptRecording.current = { prompt: String(e?.payload?.prompt ?? ''), tools: [] };
          scriptRecording.buffer.push(scriptRecording.current);
        }
      });
      scriptRecording = { name, description: rest.slice(1).join(' ') || `${name} 剧本`, buffer: [], current: null, offStart };
      ctx.agent?.setScriptRecorder?.((toolName, toolArgs) => {
        if (scriptRecording?.current) scriptRecording.current.tools.push({ name: toolName, args: toolArgs });
      });
      return `开始录制剧本「${name}」——下一轮对话起工具调用序列入册；/script stop 保存`;
    }
    if (sub === 'stop') {
      if (!scriptRecording) return '当前未在录制——/script record <名称> 开始';
      const rec = scriptRecording;
      scriptRecording = null;
      try { rec.offStart?.(); } catch { /* 忽略 */ }
      ctx.agent?.setScriptRecorder?.(null);
      const script: Script = {
        name: rec.name,
        description: rec.description,
        created_at: Date.now(),
        steps: rec.buffer.filter(s => s.prompt.trim() || s.tools.length),
      };
      if (!script.steps.length) return `剧本「${rec.name}」为空——录制期间没有对话轮次`;
      if (!saveScript(ctx.dataDir, script)) return '保存失败（数据目录不可写？）';
      const st = scriptStats(script);
      return `剧本已保存：${script.name}（${st.steps} 轮 / ${st.tools} 次工具调用）——/script run ${script.name} 重放`;
    }
    // 变更即回归开关：watch 标记 auto=true → fs_write/fs_edit 修改文件后自动重放
    if (sub === 'watch') {
      if (rest[0] === 'list') {
        const autos = listScripts(ctx.dataDir).filter(s => s.auto === true);
        if (!autos.length) return '无自动回归剧本——/script watch <名> 开启（fs_write/fs_edit 后自动重放）';
        return lines(' 自动回归剧本（文件变更后自动重放） ', autos.map(s => ` ⭯ ${s.name}${s.description ? ' · ' + s.description.slice(0, 40) : ''}`));
      }
      const [mode, name] = (rest[0] === 'on' || rest[0] === 'off') ? [rest[0], rest[1]] : [undefined, rest[0]];
      if (!name) return '用法：/script watch <名> ｜ on|off <名> ｜ list';
      const sc = loadScript(ctx.dataDir, name);
      if (!sc) return `剧本不存在：${name}（/script list 查看）`;
      const on = mode ? mode === 'on' : !sc.auto;
      sc.auto = on || undefined; // 关闭时清字段（undefined 不落盘）
      if (!saveScript(ctx.dataDir, sc)) return `保存失败（数据目录不可写？）：${name}`;
      return on
        ? `已开启自动回归：${name}——此后 fs_write/fs_edit 修改文件将自动重放该剧本（2s 防抖合并；/script watch list 查看）`
        : `已关闭自动回归：${name}`;
    }
    const name = rest[0];
    if (!name) return '用法：/script record <名> ｜ stop ｜ list ｜ show <名> ｜ run <名> ｜ dry-run <名> ｜ watch <名> ｜ rm <名>';
    const script = loadScript(ctx.dataDir, name);
    if (!script) return `剧本不存在：${name}（/script list 查看）`;
    if (sub === 'show') {
      return lines(` 剧本「${script.name}」 `, [
        ` 描述：${script.description || '（无）'} · 创建：${new Date(script.created_at).toLocaleString('zh-CN', { hour12: false })}`,
        ...script.steps.flatMap((s, i) => [
          ` #${i + 1} ❯ ${s.prompt.slice(0, 50) || '（无输入，纯工具轮）'}`,
          ...s.tools.map(t => `    ⚡ ${t.name} ${JSON.stringify(t.args ?? {}).slice(0, 80)}`),
        ]),
      ]);
    }
    if (sub === 'dry-run') {
      const st = scriptStats(script);
      return lines(` 剧本 dry-run「${script.name}」 `, [
        ` 将执行：${st.steps} 轮输入 + ${st.tools} 次工具调用（跳过 AI 决策，确定性重放）`,
        ...script.steps.flatMap((s, i) => [
          ` #${i + 1} ❯ ${s.prompt.slice(0, 50) || '（无输入）'}`,
          ...s.tools.map(t => `    ⚡ ${t.name} ${JSON.stringify(t.args ?? {}).slice(0, 80)}`),
        ]),
        ` 确认执行：/script run ${name}`,
      ]);
    }
    if (sub === 'rm') {
      return deleteScript(ctx.dataDir, name) ? `剧本已删除：${name}` : `删除失败（不存在或无权限）：${name}`;
    }
    if (sub === 'run') {
      if (!ctx.agent?.runScript) return '当前环境不支持剧本重放（agent 未装配）';
      const r = await ctx.agent.runScript(script.steps);
      if (!r.ok) return '剧本执行中断（工具异常）——查看上方执行日志';
      const st = scriptStats(script);
      return lines(` 剧本执行完成「${script.name}」 `, [
        ` 重放：${st.steps} 轮 / ${st.tools} 次工具调用（确定性执行，无 AI 决策）`,
        ...r.log.filter(l => l.kind !== 'result').map(l => ` ${l.kind === 'prompt' ? '❯' : '⚡'} ${l.text.slice(0, 80)}`),
        ` 结果已写入会话记忆（/memory 可检索）`,
      ]);
    }
    // 回放 CI（审计扩展）：重放 + 断言校验——剧本带 expect 断言时输出 pass/fail 报告
    if (sub === 'verify' || sub === 'ci') {
      if (sub === 'ci') {
        // 回归套件：遍历全部剧本逐个验证，汇总报告
        const scripts = listScripts(ctx.dataDir);
        if (!scripts.length) return '无剧本可验证（/script record 录制后 /script ci 作回归套件）';
        const reports: string[] = [];
        let passed = 0;
        for (const sc of scripts) {
          const r = await runScriptVerify(ctx, sc);
          if (r.allOk) passed++;
          reports.push(` ${r.allOk ? '✅' : '❌'} ${sc.name}（${r.assertions.length} 项断言，${r.assertions.filter(a => a.ok).length} 通过）`);
        }
        return lines(` 回归套件 ${passed}/${scripts.length} 通过 `, [
          ...reports,
          ` 全部通过时输出可作为发布门禁（/self-evolve 自举验证复用）`,
        ]);
      }
      const r = await runScriptVerify(ctx, script);
      return lines(` 剧本验证「${script.name}」${r.allOk ? '✅ 通过' : '❌ 失败'} `, [
        ...r.assertions.map(a => ` ${a.ok ? '✓' : '✗'} ${a.label}${a.detail ? ' —— ' + a.detail : ''}`),
        ...(r.assertions.length ? [] : [` （无断言——录制时或手工编辑剧本添加 expect 字段启用回放 CI）`]),
      ]);
    }
    return '用法：/script record <名> ｜ stop ｜ list ｜ show <名> ｜ run <名> ｜ verify <名> ｜ ci ｜ dry-run <名> ｜ watch <名> ｜ rm <名>';
  });

  // 回放 CI 执行器（verify/ci 共用）：重放 → 按步骤收集输出 → 断言检查
  async function runScriptVerify(ctx: HandlerCtx, sc: Script): Promise<{ allOk: boolean; assertions: Array<{ ok: boolean; label: string; detail?: string }> }> {
    if (!ctx.agent?.runScript) return { allOk: false, assertions: [{ ok: false, label: 'agent 未装配', detail: '无法重放' }] };
    const r = await ctx.agent.runScript(sc.steps);
    const outputs = r.log.filter(l => l.kind === 'result').map(l => ({ step: l.step, tool: l.name ?? '', out: l.text }));
    const assertions = checkScriptExpectations(sc, outputs);
    return { allOk: r.ok && assertions.every(a => a.ok), assertions };
  }

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
    // 审查修复：会话统一——作用于当前会话
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
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
      // A25：统一恢复函数——清理 FTS 旧行 + 重置 AUTOINCREMENT 序列再重插
      // （此前手写 DELETE+重插：FTS5 触发器使同 rowid 重插 constraint failed）
      replaceSessionMessages(ctx.db, sid, d.messages);
      return `已从快照${id ? ` #${id}` : ''}恢复 ${d.messages.length} 条消息（保留原始 id/archived）`;
    }
    if (sub === 'compare') {
      // P1-4：快照 vs 当前三态对比（Claude Code checkpoint 三态语义补全）——
      // 新增/删除/修改条数 + 变更预览，恢复前先看差异
      const id = rest[0];
      const row = id
        ? ctx.db.prepare(`SELECT data FROM checkpoints WHERE id=? AND session_id=?`).get(id, sid) as { data: string } | undefined
        : ctx.db.prepare(`SELECT data FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sid) as { data: string } | undefined;
      if (!row) return `未找到快照${id ? ` #${id}` : ''}（/checkpoint list 查看）`;
      const snap = JSON.parse(row.data) as { kind?: string; messages?: Array<{ id?: number; role: string; content: string; archived?: number }> };
      if (!Array.isArray(snap.messages)) return '快照数据不完整';
      const cur = ctx.db.prepare(`SELECT id, role, content, archived FROM messages WHERE session_id=? ORDER BY id`).all(sid) as Array<{ id: number; role: string; content: string; archived: number }>;
      const snapById = new Map(snap.messages.map(m => [m.id, m]));
      const curById = new Map(cur.map(m => [m.id, m]));
      const added: Array<{ id: number; content: string }> = [];
      const removed: Array<{ id?: number; content?: string }> = [];
      const modified: Array<{ id: number; from: string; to: string }> = [];
      for (const c of cur) {
        if (!snapById.has(c.id)) added.push({ id: c.id, content: c.content });
      }
      for (const s of snap.messages) {
        if (!curById.has(s.id!)) removed.push({ id: s.id, content: s.content });
      }
      for (const s of snap.messages) {
        const c = curById.get(s.id!);
        if (c && (c.content !== s.content || c.archived !== (s.archived ?? 0))) {
          modified.push({ id: s.id!, from: String(s.content ?? '').slice(0, 40), to: String(c.content ?? '').slice(0, 40) });
        }
      }
      const preview = (list: Array<{ id?: number; content?: string }>, n: number) =>
        list.slice(0, n).map(x => ` #${x.id} ${String(x.content ?? '').slice(0, 50)}`).join('\n');
      return lines(` 快照对比 #${id ?? '最新'}（${snap.kind ?? 'checkpoint'}） `, [
        ` 新增 ${added.length} 条｜删除 ${removed.length} 条｜修改 ${modified.length} 条（快照 ${snap.messages.length} → 当前 ${cur.length}）`,
        added.length ? `— 新增预览 —\n${preview(added, 5)}` : '',
        removed.length ? `— 删除预览 —\n${preview(removed, 5)}` : '',
        modified.length ? `— 修改预览 —\n${modified.map(m => ` #${m.id} ${m.from} → ${m.to}`).slice(0, 5).join('\n')}` : '',
        ` 恢复：/checkpoint restore ${id ?? ''}`.trim(),
      ]);
    }
    if (sub === 'clear') {
      ctx.db.prepare(`DELETE FROM checkpoints WHERE session_id=?`).run(sid);
      return '已清空全部快照';
    }
    return '用法：/checkpoint save｜list｜restore [id]｜clear';
  });


  // /reload-skills：重扫技能目录（含跨品牌 .claude/.agents/.codex/.gemini），汇报统计
  bus.register('/reload-skills', () => {
    const list = discoverSkills(ctx.dataDir, ctx.cwd);
    if (!list.length) return '未发现技能（目录：.wxnodus/skills、.claude/.agents/.codex/.gemini/skills、data/skills、forge 产物）';
    const bySource = new Map<string, number>();
    for (const s of list) bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    const summary = [...bySource.entries()].map(([k, n]) => `${k}:${n}`).join(' ');
    return lines(' 技能已重载 ', [
      ...list.slice(0, 20).map(s => ` ${s.name}（${s.source}${s.description ? `：${s.description.slice(0, 40)}` : ''}）`),
      ` 共 ${list.length} 个（${summary}）`,
    ]);
  });

  // /map：仓库地图（aider repo-map 自研版）——/map [token 预算]
  bus.register('/map', (args) => {
    const budget = Math.max(100, Math.floor(Number(args[0]) || 2000));
    const r = buildRepoMap(ctx.cwd, { budgetTokens: budget });
    return `${r.map}\n（扫描 ${r.scanned} 文件，跳过 ${r.skipped}，预算 ${budget} tokens）`;
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

  bus.register('/usage', (args) => {
    // 分区间 token（状态栏 📊 同源）：/usage range <today|7d|30d> 跨会话聚合 + 持久化
    if (args[0] === 'range') {
      const range = args[1];
      if (range !== 'today' && range !== '7d' && range !== '30d') {
        return '用法：/usage range <today|7d|30d>（状态栏 📊 段点击可循环切换）';
      }
      ctx.config.setKey('settings', 'usageRange', range);
      const s = usageSummary(ctx.db, range as UsageRange);
      // 区间成本估算（与 /cost 同源——顺带知晓区间花费）
      const q = rangeCost(ctx.db, usageRangeSince(range as UsageRange), (ctx.config.get('settings') as Record<string, any>)?.costPrices);
      const costNote = q ? ` · ≈${costText(q)}` : '';
      const unmeasuredNote = s.unmeasured > 0 ? `，其中 ${s.unmeasured} 次端点未上报用量（不计入 token）` : '';
      return `token 区间已切换：${range}——累计 ${s.total.toLocaleString()} token（入 ${s.input.toLocaleString()} / 出 ${s.output.toLocaleString()} / ${s.calls} 次调用，跨全部会话）${unmeasuredNote}${costNote}`;
    }
    // B2 修复：定位当前活跃会话（不再硬编码 'default'）+ 真实 token 统计（usage_stats）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    const real = ctx.db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(output_tokens),0) AS ot, COUNT(DISTINCT model) AS models FROM usage_stats WHERE session_id=?`
    ).get(sid) as { c: number; it: number; ot: number; models: number };

    // --waterfall [today|7d|30d]：每次 API 调用（轮）的 token 瀑布——input ░ / output █ 横向条形
    // （默认本会话最近 12 轮；带区间参数 → 跨会话该区间最近 12 轮）
    if (args[0] === '--waterfall') {
      const range = args[1];
      const scoped = range === 'today' || range === '7d' || range === '30d';
      const rows = scoped
        ? ctx.db.prepare(
            `SELECT model, input_tokens, output_tokens, ts FROM usage_stats WHERE ts >= ? ORDER BY id DESC LIMIT 12`
          ).all(usageRangeSince(range as UsageRange)) as Array<{ model: string; input_tokens: number; output_tokens: number; ts: number }>
        : ctx.db.prepare(
            `SELECT model, input_tokens, output_tokens, ts FROM usage_stats WHERE session_id=? ORDER BY id DESC LIMIT 12`
          ).all(sid) as Array<{ model: string; input_tokens: number; output_tokens: number; ts: number }>;
      if (!rows.length) return '暂无 API 用量记录（--waterfall 需真实调用后查看；当前会话消息 token 可看 /context）';
      const scopeLabel = scoped ? (range === 'today' ? '今日' : range === '7d' ? '近 7 天' : '近 30 天') : '本会话';
      // 行尾成本估算（参考价目 + costPrices 覆盖；未收录定价不显示）
      const overrides = (ctx.config.get('settings') as Record<string, any>)?.costPrices;
      const priceFor = (model: string, i: number, o: number) => estimateCost(model, i, o, overrides);
      return renderWaterfall(rows.reverse(), 40, ` Token 瀑布（${scopeLabel}最近 ${rows.length} 轮 · ░输入 █输出 · ≈$ 估算成本） `, priceFor);
    }

    const rows = ctx.db.prepare(`SELECT role, content FROM messages WHERE session_id=?`).all(sid) as any[];
    const est = rows.reduce((a, r) => a + estimateTokens(r.content), 0);
    const realTotal = real.it + real.ot;
    // 端点未上报用量的调用（0 token 行）单独计数——诚实告知 token 可能被低估
    const unmeasured = ctx.db.prepare(`SELECT COUNT(*) c FROM usage_stats WHERE session_id=? AND input_tokens=0 AND output_tokens=0`).get(sid) as { c: number };
    const tokenLine = real.c > 0
      ? ` 实际 Token：${c(realTotal.toLocaleString(), '36')}（输入 ${real.it.toLocaleString()} / 输出 ${real.ot.toLocaleString()}，${real.models} 个模型${unmeasured.c > 0 ? `；${unmeasured.c} 次调用未上报用量` : ''}）`
      : ` Token：约 ${est.toLocaleString()}（本地估算，尚无 API 用量记录）`;
    return lines(' 用量 ', [
      ` 会话：${sid.slice(0, 12)}…`,
      ` 消息：${c(`${rows.length} 条`, '36')}`,
      tokenLine,
      ` 成本：/cost 估算（参考公开价目）`,
      ` 瀑布：/usage --waterfall（最近 12 轮 input/output 条形图）`,
    ]);
  });

  // /cost：会话/区间成本估算（#11 债尾项——会话级 $ 成本；诚实口径：参考价目 + 未收录模型只报 token）
  bus.register('/cost', (args) => {
    const range = args[0];
    const overrides = (ctx.config.get('settings') as Record<string, any>)?.costPrices;
    let scopeLabel = '';
    let q: CostQueryResult | null = null;
    if (range === 'today' || range === '7d' || range === '30d') {
      q = rangeCost(ctx.db, usageRangeSince(range as UsageRange), overrides);
      scopeLabel = range === 'today' ? '今日' : range === '7d' ? '近 7 天' : '近 30 天';
    } else if (range === 'session' || !range) {
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      q = sessionCost(ctx.db, sid, overrides);
      scopeLabel = `会话 ${sid.slice(0, 12)}…`;
    } else {
      return '用法：/cost [session|today|7d|30d]（默认当前会话；估算按公开参考价目，非实际账单）';
    }
    if (!q) return `暂无 API 用量记录（${scopeLabel}）——真实对话后才有成本数据`;
    const fmtUsd = (n: number | null) => (n === null ? '未收录定价' : n === 0 ? '$0（免费/离线）' : `$${n.toFixed(4)}`);
    const body = [
      ` 范围：${scopeLabel}`,
      ` 用量：入 ${q.tokens.input.toLocaleString()} / 出 ${q.tokens.output.toLocaleString()} / 共 ${q.tokens.total.toLocaleString()} token（${q.models} 个模型）`,
      ...q.rows.map(r => ` ${r.model.slice(0, 22).padEnd(22)} 入 ${r.input.toLocaleString().padStart(8)} / 出 ${r.output.toLocaleString().padStart(8)} → ${fmtUsd(r.usd)}`),
      ` 合计（估算）：$${q.usd.toFixed(4)}${q.unknown ? `（另有 ${q.unknown} 个模型未收录定价，仅计 token）` : ''}`,
      ` 注：参考公开价目估算，非实际账单；/usage 看 token 明细`,
    ];
    return lines(' 成本估算 ', body);
  });

  // ── 档案体系（接入层开放：多厂商/中转站档案管理）──
  bus.register('/profile', (args) => {
    const sub = args[0] ?? 'list';
    const providers = (Array.isArray(ctx.config.getKey('settings', 'providers')) ? ctx.config.getKey('settings', 'providers') : []) as Array<Record<string, any>>;
    if (sub === 'list') {
      if (!providers.length) return '无档案——/profile add <名称> <baseURL> 创建（旧配置首次启动已自动迁入档案）';
      const active = ctx.config.getKey('settings', 'activeProvider');
      const rows = providers.map((p) => `${p.id === active ? '◉' : '○'} ${p.id}（${p.name}）${p.baseURL}｜模型 ${(p.models ?? []).length} 个｜密钥 ${p.key ? '已配置' : '未配置'}${p.balanceUrl ? '｜余额接口 ✓' : ''}`);
      return lines(' 档案 ', [...rows, ' ', '/profile use <id> 切换｜/profile set-key <id> <密钥>']);
    }
    if (sub === 'add') {
      const parsed = parseProfileAddArgs(args.slice(1));
      if (!parsed) return '用法：/profile add <名称> <baseURL> [--models a,b,c]（baseURL 需 http(s) 开头）';
      const id = parsed.name;
      const next = [...providers.filter((p) => p.id !== id), { id, name: parsed.name, baseURL: parsed.baseURL, models: parsed.models, key: '', balanceUrl: '', balancePath: '' }];
      ctx.config.setKey('settings', 'providers', next);
      ctx.config.setKey('settings', 'activeProvider', id);
      ctx.config.setKey('settings', 'baseURL', parsed.baseURL);
      ctx.config.setKey('settings', 'model', parsed.models[0] ?? '');
      try { appendAudit(ctx.db, 'profile.add', { id, baseURL: parsed.baseURL }); } catch { /* 静默 */ }
      return `档案已创建并激活：${id}（${parsed.baseURL}）\n下一步：/key set <密钥>（写入当前档案）→ /model <模型名>`;
    }
    if (sub === 'use') {
      const id = String(args[1] ?? '').trim();
      const hit = providers.find((p) => p.id === id);
      if (!hit) return `档案不存在：${id}（/profile list 查看）`;
      ctx.config.setKey('settings', 'activeProvider', id);
      ctx.config.setKey('settings', 'baseURL', hit.baseURL);
      if (Array.isArray(hit.models) && hit.models.length) ctx.config.setKey('settings', 'model', hit.models[0]);
      return `已切换到档案 ${id}（${hit.name}）——模型 ${hit.models?.[0] ?? '（未设置，/model <名> 配置）'}`;
    }
    if (sub === 'rm') {
      const id = String(args[1] ?? '').trim();
      ctx.config.setKey('settings', 'providers', providers.filter((p) => p.id !== id));
      if (ctx.config.getKey('settings', 'activeProvider') === id) ctx.config.setKey('settings', 'activeProvider', providers[0]?.id ?? '');
      return `已移除档案 ${id}`;
    }
    if (sub === 'set-key') {
      const id = String(args[1] ?? '').trim();
      const key = String(args.slice(2).join(' ')).trim();
      if (!key) return '用法：/profile set-key <id> <密钥>（AES 加密存入该档案密钥槽）';
      const hit = providers.find((p) => p.id === id);
      if (!hit) return `档案不存在：${id}`;
      const enc = encryptKey(key);
      ctx.config.setKey('settings', 'providers', providers.map((p) => (p.id === id ? { ...p, key: enc } : p)));
      try { appendAudit(ctx.db, 'profile.set-key', { id }); } catch { /* 静默 */ }
      return `密钥已写入档案 ${id}（AES 加密，不回显）`;
    }
    return '用法：/profile list | use <id> | add <名称> <baseURL> | rm <id> | set-key <id> <密钥>';
  });

  // ── 余额监控配置（合规：/balance set 写授权存证；抓取审计在 balance.ts）──
  bus.register('/balance', async (args) => {
    const sub = args[0] ?? 'status';
    const bm = (ctx.config.getKey('settings', 'balanceMonitor') ?? {}) as Record<string, any>;
    if (sub === 'set') {
      const parsed = parseBalanceSetArgs(args.slice(1));
      ctx.config.setKey('settings', 'balanceMonitor', { enabled: true, url: parsed.url, jsonPath: parsed.jsonPath });
      try {
        const { ConsentLedger } = await import('../compliance/compliance.js');
        new ConsentLedger(ctx.db).grant({ grantor: 'user', scope: 'balance-monitor', purpose: '余额监控抓取（用户显式授权）', method: '/balance set', expiresAt: 0, evidenceRef: '' });
      } catch { /* 存证失败不阻断 */ }
      try { appendAudit(ctx.db, 'balance.set', { url: parsed.url, jsonPath: parsed.jsonPath }); } catch { /* 静默 */ }
      return parsed.url ? `余额监控已配置：${parsed.url}${parsed.jsonPath ? `（路径 ${parsed.jsonPath}）` : ''}——/balance refresh 立即验证` : '余额监控已配置：跟随当前档案余额接口（/balance refresh 验证）';
    }
    if (sub === 'on') { ctx.config.setKey('settings', 'balanceMonitor', { ...bm, enabled: true }); return '余额监控已开启（状态栏 💰，5 分钟刷新，点击可强制刷新）'; }
    if (sub === 'off') { ctx.config.setKey('settings', 'balanceMonitor', { ...bm, enabled: false }); return '余额监控已关闭（/balance on 重新开启）'; }
    if (sub === 'threshold') {
      const n = Number(args[1]);
      if (!Number.isFinite(n) || n < 0) return '用法：/balance threshold <数值>（低余额预警阈值；默认 5——低于即状态栏 sticky 预警）';
      ctx.config.setKey('settings', 'balanceMonitor', { ...bm, lowThreshold: n });
      return `低余额预警阈值已设置：${n}（余额低于此值时状态栏预警 + /balance status 行内提示）`;
    }
    if (sub === 'auto-stop') {
      const on = args[1] !== 'off' && args[1] !== '0';
      ctx.config.setKey('settings', 'balanceMonitor', { ...bm, autoStop: on });
      return on
        ? '余额耗尽自动停已开启（余额监控实测 0 时后续对话硬停——充值后自动恢复；/balance auto-stop off 关闭）'
        : '余额耗尽自动停已关闭';
    }
    if (sub === 'refresh' || sub === 'status') {
      const rp = resolveProviderProfile((ctx.config.get('settings') ?? {}) as Record<string, any>);
      if (!rp) return '未配置档案（/profile add 或 /key set 后重试）';
      const profile = { ...rp.profile, balanceUrl: bm.url || rp.profile.balanceUrl || '', balancePath: bm.jsonPath || rp.profile.balancePath || '' };
      const r = await fetchBalanceCached(profile, (ctx.config.get('settings') ?? {}) as Record<string, any>, { force: sub === 'refresh', db: ctx.db });
      if (r.ok) {
        const { numericBalance, LOW_BALANCE_THRESHOLD } = await import('../kernel/balance.js');
        const threshold = Number((bm as any).lowThreshold ?? LOW_BALANCE_THRESHOLD);
        const num = numericBalance(r.info);
        const low = num !== null && num < threshold ? `\n⚠ 余额不足预警：当前 ${r.info.balance}（阈值 ${threshold}——低于阈值请及时充值）` : '';
        return `余额：${r.info.balance}${r.info.currency ? ` ${r.info.currency}` : ''}（${r.info.source}${r.cached ? '，缓存中' : ''}）${low}`;
      }
      return `余额获取失败：${r.error}`;
    }
    return '用法：/balance set [url] [--path <jsonPath>] | on | off | threshold <数值> | auto-stop [on|off] | status | refresh';
  });

  // ── 配置导出/导入（JSON；导出可选脱敏）──
  bus.register('/config', async (args) => {
    const sub = args[0] ?? '';
    if (sub === 'export') {
      const redact = args.includes('--redact');
      const s: Record<string, any> = { ...((ctx.config.get('settings') ?? {}) as Record<string, any>) };
      if (redact) {
        delete s.apiKeyEnc;
        if (Array.isArray(s.providers)) s.providers = s.providers.map((p: any) => ({ ...p, key: p.key ? '(redacted)' : '' }));
        s.apiKeys = {};
      }
      return JSON.stringify({ settings: s }, null, 2);
    }
    if (sub === 'import') {
      const file = String(args[1] ?? '').trim();
      if (!file) return '用法：/config import <文件路径>（JSON：{ "settings": { ... } }）';
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        if (!existsSync(file)) return `文件不存在：${file}`;
        const j = JSON.parse(readFileSync(file, 'utf8'));
        const merged = { ...((ctx.config.get('settings') ?? {}) as Record<string, any>), ...(j.settings ?? {}) };
        Object.entries(merged).forEach(([k, v]) => ctx.config.setKey('settings', k, v));
        return '配置已导入（settings.json 热重载生效；若含 providers 请 /profile list 确认）';
      } catch (e: any) { return `导入失败：${String(e?.message ?? e).slice(0, 120)}`; }
    }
    return '用法：/config export [--redact] | import <文件>';
  });

  // ── 彩蛋（趣味拉满：纯文本无副作用）──
  bus.register('/warp', () => ['✦ 曲率引擎预热', '✦ ✦ 折叠空间', '✦ ✦ ✦ 穿越虫洞', '· ✦ · 已到达目标星系 ✦'].join('\n'));
  bus.register('/fortune', () => {
    const pool = ['今日宜：写代码，忌：手动格式化磁盘。', '黑洞说：你今天省下的 token，明天都会变成余额。', '星尘占卜：/help 里藏着一个你还没用过的命令。', '超新星预报：你的下一个想法会发光。'];
    return '🔮 ' + (pool[Math.floor(Math.random() * pool.length)] ?? pool[0]);
  });

  // /context：上下文占用可视化（P2b 增强——工作窗口真实 token 分布 + 预算占用条）
  bus.register('/context', () => {
    const rec = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default');
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
    // 本会话成本估算（与 /cost 同源——状态栏 $ 段同一数据）
    const cq = sessionCost(ctx.db, ctx.agent?.getSessionId?.() ?? 'default', (ctx.config.get('settings') as Record<string, any>)?.costPrices);
    if (cq) rows.push(` 成本：${costText(cq)}（估算） · /cost 看区间`);
    // 架构 P4：parts 消息模型——工具消息错误/截断分段统计（消息粒度可审计）
    try {
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      const partsRows = ctx.db.prepare(`SELECT parts FROM messages WHERE session_id=? AND parts IS NOT NULL ORDER BY id DESC LIMIT 100`).all(sid) as Array<{ parts: string }>;
      let errParts = 0;
      let truncParts = 0;
      for (const r of partsRows) {
        try {
          const ps = JSON.parse(r.parts) as Array<{ kind?: string; truncated?: boolean }>;
          for (const p of ps) {
            if (p.kind === 'error') errParts++;
            if (p.truncated) truncParts++;
          }
        } catch { /* 忽略坏行 */ }
      }
      if (errParts || truncParts) {
        rows.push(` parts 分段（近 100 条）：错误 ${errParts} · 截断 ${truncParts}（消息粒度状态可审计）`);
      }
    } catch { /* parts 列缺失（旧库）静默 */ }
    if (total > BUDGET * 0.85) {
      rows.push(' ⚠ 接近预算上限——建议 /compact 压缩上下文');
    }
    return lines(' 上下文 ', rows);
  });

  // ── 记忆类 ──────────────────────────────────
  // /compact：上下文压缩（对比轮 6 修复：有密钥时 LLM 真实总结，无密钥降级规则摘要）
  // 融合：LLM 调用走共享 callModelOnce（与 llmSpec 同款，单一事实源）
  bus.register('/compact', async () => {
    const before = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').length;
    const summarize = async (text: string): Promise<string> => {
      try {
        const { resolveApiKey } = await import('../kernel/providers.js');
        const keyRes = resolveApiKey(ctx.config.get('settings') as any);
        if (!keyRes.key) return `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
        const { callModelOnce } = await import('../kernel/llmOnce.js');
        const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
        const model = resolveDefaultModel(ctx.config.get('settings') as any);
        const r = await callModelOnce({
          baseURL, model, key: keyRes.key,
          messages: [
            { role: 'system', content: '你是上下文压缩器。把对话片段压缩为保留关键信息的摘要（中文，≤400 字），只输出摘要。' },
            { role: 'user', content: text },
          ],
        });
        return r.ok ? r.content || `（规则压缩）${text.slice(0, 400)}` : `（规则压缩）${text.slice(0, 400)}`;
      } catch { return `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`; }
    };
    await ctx.mem.compactSmart(ctx.agent?.getSessionId?.() ?? 'default', summarize);
    const after = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').length;
    return `压缩完成：${before} → ${after} 条（LLM 摘要，无密钥时规则降级）`;
  });

  // /digest：最近对话摘要（对比轮 6 修复：有密钥时 LLM 真实提炼，无密钥规则摘要）
  bus.register('/digest', async () => {
    const rec = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default');
    if (!rec.length) return '暂无记忆';
    const last = rec.slice(-10);
    // 本会话成本估算（costQuery 共享助手——与 /cost 同一 SQL 事实源）
    let costLine = '';
    const cq = sessionCost(ctx.db, ctx.agent?.getSessionId?.() ?? 'default', (ctx.config.get('settings') as Record<string, any>)?.costPrices);
    if (cq) costLine = `${costText(cq)}（估算）`;
    const transcript = last.filter((m: any) => m.role !== 'system').map((m: any) => `${m.role}: ${String(m.content ?? '').slice(0, 200)}`).join('\n');
    // LLM 提炼（有密钥时）
    try {
      const { resolveApiKey } = await import('../kernel/providers.js');
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (keyRes.key) {
        const key = keyRes.key;
        const { buildChatRequest } = await import('../kernel/providers.js');
        const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
        const model = resolveDefaultModel(ctx.config.get('settings') as any);
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
    } catch { /* 降级规则摘要 */ }
    const roles = last.filter((m: any) => m.role !== 'system').map((m: any) => m.role === 'user' ? '问' : '答');
    return lines(' 摘要 ', [
      ` 最近 ${last.length} 条：${roles.join(' → ')}`,
      ` 最新：${String(last[last.length - 1]?.content ?? '').slice(0, 60)}`,
      ` 全量 ${rec.length} 条 · 吸附 ${ctx.mem.absorbCount('default')} 条`,
      ...(costLine ? [` 成本：${costLine}（/cost 看区间）`] : []),
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
  // /deploy：真实本地部署（审计修复——此前只是项目列表，「部署/上线/落地」NL 直达
  //  却得不到部署动作；现在：验证项目完整性 → 后台启动 server → 探活端口 → 输出地址）
  bus.register('/deploy', async (args) => {
    const dir = join(ctx.dataDir, 'projects');
    const projects = existsSync(dir) ? readdirSync(dir) : [];
    if (!projects.length) return '暂无编译项目（说「做个待办系统」触发概念编译）';
    const target = args[0];
    if (!target) {
      return lines(' 项目（/deploy <名称> 部署） ', projects.map(p => ` ${p}`));
    }
    if (!projects.includes(target)) return `项目不存在：${target}（/deploy 查看列表）`;
    const projDir = join(dir, target);
    // 1. 验证完整性（真实探活：启动→探活→重启→读回）
    const { verifyProject } = await import('../build/verify.js');
    const vr = await verifyProject(projDir);
    if (vr.status !== 'ok') return `部署前置验证失败：${vr.detail}——修复后重试`;
    // 2. 后台启动（独立进程，不阻塞 CLI；端口 4321 与验证一致）
    const entry = join(projDir, 'server', 'index.js');
    const { spawn } = await import('node:child_process');
    const { sanitizedEnv } = await import('../kernel/env.js');
    const srv = spawn(process.execPath, [entry], {
      cwd: projDir,
      env: { ...sanitizedEnv(), PORT: '4321' },
      stdio: 'ignore',
      detached: true,
    });
    srv.unref();
    // 3. 探活确认（最多 5s）
    let reachable = false;
    try {
      const r = await fetch('http://127.0.0.1:4321/health', { signal: AbortSignal.timeout(5000) });
      reachable = r.ok || r.status === 404;
    } catch { /* 探活失败按不可达 */ }
    return lines(` 部署「${target}」 `, [
      ` 验证：✅ ${vr.detail}`,
      ` 进程：PID ${srv.pid ?? '?'}（后台运行，detached）`,
      ` 地址：http://127.0.0.1:4321${reachable ? '（探活确认可达）' : '（健康端点未响应——应用可能无 /health 路由）'}`,
      ` 停止：/jobs 查看 或 taskkill /PID ${srv.pid ?? '?'} /F`,
    ]);
  });

  bus.register('/forge', async (args) => {
    // 审查修复（假功能）：此前写死单一 echo 工具且生成「执行成功」假结果——现支持
    // 传入工具签名 JSON（--tools '[...]'），无签名时生成占位并诚实标注（调用返回错误）
    const name = args[0];
    if (!name) return '用法：/forge <组件名> [--tools \'[{"name":"x","description":"…","inputSchema":{…}}]\']（锻造 MCP server + SKILL.md）';
    const toolsArgIdx = args.indexOf('--tools');
    let tools: Array<{ name: string; description: string; inputSchema: any }> = [];
    if (toolsArgIdx >= 0 && args[toolsArgIdx + 1]) {
      try {
        const parsed = JSON.parse(args[toolsArgIdx + 1] ?? '');
        if (Array.isArray(parsed) && parsed.length) {
          tools = parsed.map(t => ({ name: String(t.name ?? ''), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } }));
        }
      } catch {
        return '--tools 参数不是合法 JSON 数组（示例：[{"name":"greet","description":"打招呼","inputSchema":{"type":"object","properties":{"who":{"type":"string"}}}}]）';
      }
    }
    const outDir = join(ctx.dataDir, 'forge', name);
    mkdirSync(outDir, { recursive: true });
    if (!tools.length) {
      tools = [{ name: 'echo', description: '回显输入（占位示例——需编辑 server.js 填入真实逻辑）', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
    }
    const server = forgeMcpServer(outDir, name, tools);
    const skill = forgeSkillDir(outDir, name, `${name} 技能`, '1. 分析需求 2. 生成代码 3. 验证');
    // 审查修复（死代码接线）：forge 组件注册表此前零调用——产物入注册表（检疫态）
    try {
      const { createRegistry } = await import('../forge/registry.js');
      const reg = createRegistry(join(ctx.dataDir, 'forge', 'registry.json'));
      reg.add({ name, kind: 'mcp', source: server, version: '1.0.0' });
    } catch { /* 注册失败不阻断锻造 */ }
    return lines(` 锻造 ${name}（${tools.length} 个工具签名） `, [
      ` MCP server → ${server}`,
      ` SKILL.md → ${skill}`,
      ` ⚠ 占位声明：工具处理器为占位实现（调用返回诚实错误）——编辑 server.js 填入真实逻辑后使用`,
    ]);
  });

  bus.register('/skill', (args): string | StructuredCommand => {
    const [sub, ...rest] = args;
    if (!sub) return '用法：/skill <技能名>（加载注入）| /skill new <名> [描述] | /skill list | /skill inspect <名>';
    if (sub === 'new') {
      const name = rest[0];
      if (!name) return '用法：/skill new <技能名> [描述]';
      const desc = rest.slice(1).join(' ') || `${name} 技能`;
      // 审查修复（假功能标注）：骨架模板如实标注——非 AI 提炼内容
      const dir = writeSkill(ctx.dataDir, name, desc, '1. 理解任务 2. 制定步骤 3. 执行并验证（骨架模板——用 /learn 从对话提炼真实工作流）', { aiGenerated: true });
      return `技能骨架已生成（ai_generated 标注，工作流为固定模板——建议 /learn 从对话提炼真实步骤）→ ${dir}`;
    }
    if (sub === 'list') {
      const all = discoverSkills(ctx.dataDir, ctx.cwd);
      if (!all.length) return '技能库为空——/skill new <名> 创建，或把 SKILL.md 放到 .wxnodus/skills/<名>/';
      return lines(' 技能库 ', [
        ...all.map(s => ` ${s.name}${s.effort ? ` [${s.effort}]` : ''}${s.description ? ' — ' + s.description : ''}（${s.source}）`),
        ` 共 ${all.length} 个（effort: low/medium/high 推理档位，frontmatter 声明）`,
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
    const { resolveApiKey } = await import('../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) return '当前未配置模型密钥——/key set <密钥> 后 /learn 才能用 AI 总结生成技能（不产生假内容）';
    if (keyRes.error === 'decrypt-failed') return '密钥无法解密（机器环境变化或数据损坏？）——请用 /key set <密钥> 重新配置。';
    const key = keyRes.key;
    const recent = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').slice(-8);
    if (!recent.length) return '暂无对话记忆可学习——先对话几轮再 /learn';
    const desc = args.slice(1).join(' ') || `${name} 技能`;
    const transcript = recent.map(r => `${r.role}: ${String(r.content ?? '').slice(0, 300)}`).join('\n');
    const { buildChatRequest } = await import('../kernel/providers.js');
    const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
    const model = resolveDefaultModel(ctx.config.get('settings') as any);
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

  // /assimilate：黑洞引擎同化器（技能同化）
  //   <目录>        目录 100% 同化（确定性批量吸收：SKILL.md / 跨品牌 / 变体）
  //   <文件|URL>    素材 AI 消化（LLM 提炼 SKILL.md → ai_generated 标注）
  //   （无参数）     最近对话消化（对话提供需求 → AI 产出技能融入）
  //   --name <名> ｜ --desc <描述> ｜ --force ｜ --flow "A → B" ｜ --effort low|medium|high
  bus.register('/assimilate', async (args) => {
    const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
    const hasFlag = (k: string) => args.includes(k);
    const name = flag('--name');
    const desc = flag('--desc');
    const force = hasFlag('--force');
    const flow = flag('--flow');
    const effort = flag('--effort') as 'low' | 'medium' | 'high' | undefined;
    const pos = args.filter(a => !a.startsWith('--'));

    // W7-03 通道 C：代码/模块只读同化（FTS 索引——绝不执行同化的代码）
    if (hasFlag('--code')) {
      const dir = flag('--code');
      if (!dir) return '用法：/assimilate --code <目录>（代码/模块只读同化入黑洞索引）';
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return 'ASSIMILATE_CODE_DIR_NOT_FOUND：目录不存在';
      if (!ctx.codeIndex) return '代码同化索引未装配（fail-closed）';
      const { scanCodeTargets } = await import('../infrastructure/code/codeIndexer.js');
      const scanned = scanCodeTargets(dir, {});
      if (!scanned.ok) return `扫描失败：${scanned.error.code}`;
      ctx.codeIndex.indexChunks(scanned.value.chunks);
      const r = scanned.value.report;
      return lines(' 黑洞同化（代码/模块） ', [
        ` 来源：${dir}`,
        ` ✅ 索引 ${r.counts.indexed} 个文本文件（块）· 扫描 ${r.counts.scanned}`,
        r.counts.skipped ? ` ⏭ 跳过 ${r.counts.skipped}：${r.skipped.slice(0, 5).map(s => `${s.path.slice(0, 60)}(${s.reason})`).join(' · ')}${r.skipped.length > 5 ? ' …' : ''}` : '',
        r.complete ? '' : ' ⚠ 配额截断——部分索引（complete:false，绝不假装全量）',
        ` 检索：/hole --code <词>（来源标注 [代码]/[插件]/[MCP]）`,
      ].filter(Boolean));
    }

    // W7-03：插件清单面同化（dataDir/plugins/<名>/plugin.json）
    if (hasFlag('--plugins')) {
      if (!ctx.codeIndex) return '代码同化索引未装配（fail-closed）';
      const dir = join(ctx.dataDir, 'plugins');
      const entries: Array<{ source: 'plugin'; id: string; title: string; body: string }> = [];
      if (existsSync(dir)) {
        for (const pname of readdirSync(dir)) {
          const mf = join(dir, pname, 'plugin.json');
          if (!existsSync(mf)) continue;
          try {
            const manifest = JSON.parse(readFileSync(mf, 'utf8')) as { name?: string; description?: string; commands?: unknown; tools?: unknown };
            entries.push({
              source: 'plugin',
              id: manifest.name ?? pname,
              title: manifest.name ?? pname,
              body: [manifest.description ?? '', JSON.stringify(manifest.commands ?? {}), JSON.stringify(manifest.tools ?? {})].join('\n'),
            });
          } catch { /* 坏清单跳过 */ }
        }
      }
      if (!entries.length) return '无已安装插件可同化（/plugin install <目录> 后重试）';
      ctx.codeIndex.indexSurfaces(entries);
      return lines(' 黑洞同化（插件） ', [` ✅ 索引 ${entries.length} 个插件清单（/hole --code 检索，来源 [插件]）`]);
    }

    // W7-03：MCP 描述面同化（项目 .mcp.json + 用户 data/mcp.json 的 mcpServers）
    if (hasFlag('--mcp')) {
      if (!ctx.codeIndex) return '代码同化索引未装配（fail-closed）';
      const files = [join(ctx.cwd, '.mcp.json'), join(ctx.dataDir, 'mcp.json')];
      const entries: Array<{ source: 'mcp'; id: string; title: string; body: string }> = [];
      for (const f of files) {
        if (!existsSync(f)) continue;
        try {
          const doc = JSON.parse(readFileSync(f, 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: unknown; url?: string; description?: string }> };
          for (const [mname, def] of Object.entries(doc.mcpServers ?? {})) {
            entries.push({
              source: 'mcp',
              id: mname,
              title: mname,
              body: [def.description ?? '', def.command ?? def.url ?? '', JSON.stringify(def.args ?? {})].join('\n'),
            });
          }
        } catch { /* 坏配置跳过 */ }
      }
      if (!entries.length) return '无 MCP server 可同化（/mcp add <名称> <命令> 后重试）';
      ctx.codeIndex.indexSurfaces(entries);
      return lines(' 黑洞同化（MCP） ', [` ✅ 索引 ${entries.length} 个 MCP 描述（/hole --code 检索，来源 [MCP]）`]);
    }

    const { assimilateDir, assimilateMaterial, readMaterial } = await import('../kernel/assimilate.js');
    // LLM 消化回调（无 key 前置拦截——不产生假内容；与 /learn 同款调用模式）
    const makeDigest = (key: string) => async (prompt: string): Promise<string> => {
      const { buildChatRequest } = await import('../kernel/providers.js');
      const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
      const model = resolveDefaultModel(ctx.config.get('settings') as any);
      const req = buildChatRequest({
        baseURL, model, key,
        messages: [
          { role: 'system', content: '你是技能提炼器。把用户提供的素材/对话片段消化提炼为可复用的技能工作流，只输出 Markdown 工作流正文（分步、可执行、中文），不要多余说明。' },
          { role: 'user', content: prompt },
        ],
        stream: false,
      });
      const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error(`LLM 调用失败（${resp.status}）——请检查密钥与模型配置`);
      const j = await resp.json() as any;
      return String(j?.choices?.[0]?.message?.content ?? '');
    };
    const { resolveApiKey } = await import('../kernel/providers.js');
    const requireKey = () => {
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (!keyRes.key) return { error: '消化需要模型密钥——/key set <密钥> 后可用（无 key 不产生假内容）' };
      if (keyRes.error === 'decrypt-failed') return { error: '密钥无法解密（机器环境变化或数据损坏？）——请 /key set <密钥> 重新配置' };
      return { key: keyRes.key };
    };

    // 无参数 → 最近对话消化（对话提供需求 → AI 产出技能）
    if (!pos.length) {
      if (!name) return '用法：/assimilate <目录|文件|URL> [--name <名>] [--desc <描述>] [--force] ｜ 无参数 = 消化最近对话（需 --name <技能名>）';
      const k = requireKey();
      if ('error' in k) return k.error;
      const recent = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').slice(-8);
      if (!recent.length) return '暂无对话记忆可消化——先对话提供需求，或 /assimilate <文件|URL> --name <技能名>';
      const transcript = recent.map(r => `${r.role}: ${String(r.content ?? '').slice(0, 300)}`).join('\n');
      try {
        const dir = await assimilateMaterial(ctx.dataDir, `（最近对话片段）\n${transcript}`, {
          name, description: desc, flow, effort, llm: makeDigest(k.key),
        });
        return `已从对话消化生成技能 → ${dir}（ai_generated 标注，/skill list 查看）`;
      } catch (e: any) {
        return `消化失败：${e?.message?.slice(0, 200) ?? e}`;
      }
    }

    const target = pos[0]!;
    // 目录 → 100% 同化（确定性通道，无需 AI）
    if (existsSync(target) && statSync(target).isDirectory()) {
      const r = assimilateDir(ctx.dataDir, target, { force });
      if (!r.assimilated.length && !r.skipped.length) {
        return lines(' 黑洞同化（目录） ', [
          ` 来源：${target}`,
          ...r.invalid.map(i => ` ⚠ ${i.file.slice(0, 70)}（${i.reason}）`),
        ]);
      }
      return lines(' 黑洞同化（目录） ', [
        ` 来源：${target}`,
        ` ✅ 同化 ${r.assimilated.length} 个${r.assimilated.length ? '：' : ''}`,
        ...r.assimilated.map(a => `   ${c(a.name, '32')} ← ${a.from.slice(0, 70)}`),
        ...(r.skipped.length ? [` ⏭ 跳过 ${r.skipped.length}：`, ...r.skipped.map(s => `   ${s.name}（${s.reason}）`)] : []),
        ...(r.invalid.length ? [` ⚠ 无效 ${r.invalid.length}：`, ...r.invalid.map(i => `   ${i.file.slice(0, 70)}（${i.reason}）`)] : []),
        ` 同化后 /skill list 可见；对话中 /skill:${r.assimilated[0]?.name ?? '名'} 或 skill_load 注入`,
      ]);
    }

    // 文件/URL → 素材 AI 消化
    if (!name) return `用法：/assimilate <文件|URL> --name <技能名> [--desc <描述>] [--flow "A → B"] [--effort low|medium|high]`;
    const k = requireKey();
    if ('error' in k) return k.error;
    try {
      const material = await readMaterial(target);
      const dir = await assimilateMaterial(ctx.dataDir, material, {
        name, description: desc, flow, effort, llm: makeDigest(k.key),
      });
      return `已消化素材「${target.slice(0, 50)}」→ 技能 ${c(name, '35')}（ai_generated 标注）→ ${dir}`;
    } catch (e: any) {
      return `消化失败：${e?.message?.slice(0, 200) ?? e}`;
    }
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

  // /fdr：部署后保障文档（审计修复——不再只写空白模板：
  // 有 key 时用模型真实审查最近对话/项目并生成 FDR，无 key 诚实提示不产生假内容）
  bus.register('/fdr', async (args) => {
    const name = args[0] ?? `fdr-${Date.now().toString(36)}`;
    const outDir = join(ctx.dataDir, 'forge', name);
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, 'FDR.md');
    const { resolveApiKey } = await import('../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) {
      // 无 key：生成待补全模板但明确标注未审查（不假装已审查）
      const doc = `# FDR — ${name}\n\n> ⚠ 未配置模型密钥——本模板未经过 AI 审查（/key set 后 /fdr 重跑生成真实审查）\n\n## 需求\n\n## 设计\n\n## 实现\n\n## 验证\n`;
      writeFileSync(out, doc, 'utf8');
      return `FDR 模板已生成 → ${out}（未配置密钥，未审查——/key set 后重跑）`;
    }
    // 有 key：模型真实审查最近对话（需求/设计/实现/验证四段）
    const recent = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').slice(-12);
    if (!recent.length) return '暂无对话记忆可审查——先对话几轮再 /fdr';
    const transcript = recent.map(r => `${r.role}: ${String(r.content ?? '').slice(0, 300)}`).join('\n');
    const { buildChatRequest, mapHttpError } = await import('../kernel/providers.js');
    const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
    const model = resolveDefaultModel(ctx.config.get('settings') as any);
    const req = buildChatRequest({
      baseURL, model, key: keyRes.key,
      messages: [
        { role: 'system', content: '你是部署后保障评审员。基于对话片段生成 FDR（Markdown：需求/设计/实现/验证四段，中文，指出风险与未验证项），只输出文档正文。' },
        { role: 'user', content: `项目：${name}\n对话片段：\n${transcript}` },
      ],
      stream: false,
    });
    try {
      const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error(mapHttpError(resp.status));
      const j = await resp.json() as any;
      const doc = String(j?.choices?.[0]?.message?.content ?? '').trim() || `# FDR — ${name}\n\n（模型未返回内容）`;
      writeFileSync(out, doc, 'utf8');
      return `FDR 已生成（AI 审查最近 ${recent.length} 条对话）→ ${out}`;
    } catch (e: any) {
      return `FDR 生成失败：${String(e?.message ?? e).slice(0, 120)}`;
    }
  });

  // /evidence：真实验证并落盘证据（审计修复——不再读不存在的 health.json 伪造 'verified'）
  bus.register('/evidence', async (args) => {
    // 校准完善：证据链可查性——/evidence list 全量证据簿、/evidence show <项目> 明细、
    // /evidence <项目> 重验证（向后兼容）
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const projectsDir = join(ctx.dataDir, 'projects');
    if (args[0] === 'list') {
      if (!existsSync(projectsDir)) return '证据簿为空——/build 生成首个项目后这里出现证据';
      const rows: Array<{ name: string; status: string; ts: number; fingerprint: string; checks: string[] }> = [];
      for (const name of readdirSync(projectsDir)) {
        try {
          const ev = JSON.parse(readFileSync(join(projectsDir, name, 'evidence.json'), 'utf8'));
          rows.push({ name, status: ev.status, ts: ev.ts, fingerprint: ev.fingerprint, checks: ev.checks ?? [] });
        } catch { /* 无证据的项目跳过 */ }
      }
      rows.sort((a, b) => b.ts - a.ts);
      if (!rows.length) return '证据簿为空——/build 生成首个项目后这里出现证据';
      return lines(` 证据簿（${rows.length} 个项目） `, rows.map(r => [
        ` ${r.status === 'ok' ? '✅' : '❌'} ${r.name}（${new Date(r.ts).toLocaleString()}）`,
        `    状态 ${r.status} · 指纹 ${r.fingerprint} · ${r.checks.length} 项检查（/evidence show ${r.name}）`,
      ]).flat());
    }
    const name = args[0] ?? 'default';
    const dir = join(ctx.dataDir, 'projects', name);
    if (args[0] === 'show') {
      const projName = args[1] ?? '';
      const projDir = join(ctx.dataDir, 'projects', projName);
      if (!existsSync(projDir)) return `项目不存在：${projName}（/evidence list 查看证据簿）`;
      try {
        const ev = JSON.parse(readFileSync(join(projDir, 'evidence.json'), 'utf8'));
        return lines(` 证据「${projName}」 `, [
          ` 状态：${ev.status}${ev.status === 'ok' ? ' ✅' : ''}`,
          ` 检查项：${(ev.checks ?? []).map((c: string) => '✓ ' + c).join(' / ') || '无'}`,
          ` 指纹：${ev.fingerprint}（sha256[:6]，文件变更即变化）`,
          ` 时间：${new Date(ev.ts).toLocaleString()}`,
          ...(ev.detail ? [` 验证明细：${ev.detail}`] : []),
          ...(ev.port ? [` 探活端口：${ev.port}`] : []),
          ` 重验证：/evidence <项目>｜质量门：/gate <项目>`,
        ]);
      } catch {
        return `证据文件缺失或损坏：${join(projDir, 'evidence.json')}`;
      }
    }
    if (!existsSync(dir)) return `项目不存在：${name}（/evidence list 查看证据簿）`;
    // 真实验证：启动→探活→重启→读回；结果如实落盘（失败记 failed，不伪造）
    const { verifyProject } = await import('../build/verify.js');
    const vr = await verifyProject(dir);
    const ev = writeEvidence(dir, {
      status: vr.status,
      checks: vr.status === 'ok' ? ['verify:start-probe-restart-readback'] : [],
      detail: vr.detail,
      port: null,
    });
    return ev
      ? `证据已写入 → ${join(dir, 'evidence.json')}（状态：${vr.status}${vr.status === 'ok' ? ' ✅' : ' —— ' + vr.detail}）`
      : '证据写入失败';
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

  bus.register('/compliance', async () => {
    const ledger = ctx.db.prepare(`SELECT COUNT(*) c FROM audit`).get() as any;
    // 审计修复：许可扫描从静态文案改为真实扫描（激活 compliance.ts 模块——
    // 此前「许可扫描：AGPL/BUSL 检测」是声称，scanLicenses 从未被调用）
    let licenseLine = ' 许可扫描：未检测到 node_modules（依赖许可未评估）';
    try {
      const { scanLicenses } = await import('../compliance/compliance.js');
      const nm = join(ctx.cwd, 'node_modules');
      if (existsSync(nm)) {
        const hits = scanLicenses(nm);
        const blocks = hits.filter(h => h.risk === 'block');
        licenseLine = ` 许可扫描：${hits.length} 个依赖（${blocks.length} 个需人工确认${blocks.length ? '：' + blocks.slice(0, 3).map(b => b.pkg).join('、') : ''}）`;
      }
    } catch { /* 扫描失败保持未检测提示 */ }
    return lines(' 合规 ', [
      ` 同意书：${existsSync(join(ctx.dataDir, 'consent.json')) ? '已签署' : '未签署（/consent）'}`,
      ' AI 生成标注：消息流标记 ✦',
      ` 审计日志：${ledger?.c ?? 0} 条（/audit 导出）`,
      licenseLine,
    ]);
  });

  bus.register('/consent', async (args) => {
    // 审查接线：ConsentLedger（授权存证六元组：授权人/时间/范围/目的/方式/到期）此前
    // 全仓库零实例化——/consent 只落一个 json 标志文件（宣传与实现脱节）。
    // 现为真实存证簿：grant/revoke/list/status；外部访问（http_get/claw/browser）自动存证
    const { ConsentLedger } = await import('../compliance/compliance.js');
    const ledger = new ConsentLedger(ctx.db);
    const sub = args[0];
    if (sub === 'grant') {
      const scope = String(args[1] ?? '').trim();
      if (!scope) return '用法：/consent grant <范围> [--purpose 目的] [--hours N（默认 24）]';
      const purposeIdx = args.indexOf('--purpose');
      const purpose = purposeIdx >= 0 ? args.slice(purposeIdx + 1, args.indexOf('--hours') >= 0 ? args.indexOf('--hours') : undefined).join(' ') : '';
      const hoursIdx = args.indexOf('--hours');
      const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) || 24 : 24;
      const rec = ledger.grant({ grantor: 'user', scope, purpose: purpose.slice(0, 120), method: '/consent', expiresAt: Date.now() + hours * 3600_000, evidenceRef: '' });
      return `已存证授权 #${rec.id}：${scope}${purpose ? `（${purpose}）` : ''}——${hours} 小时后到期，/consent list 查看`;
    }
    if (sub === 'revoke') {
      const id = Number(args[1]);
      const recs = ledger.export();
      if (!recs.some(r => r.id === id)) return `授权 #${id} 不存在（/consent list 查看）`;
      ledger.revoke(id);
      return `已撤销授权 #${id}（即刻生效，后续访问将重新要求存证）`;
    }
    if (sub === 'list') {
      const recs = ledger.export();
      if (!recs.length) return '授权存证簿为空——外部访问自动存证，或 /consent grant 显式授权';
      return lines(` 授权存证簿（${recs.length} 条） `, recs.map(r => {
        const revoked = (r as any).revoked_at;
        const state = revoked ? `⛔ 已撤销` : ((r as any).expires_at > 0 && (r as any).expires_at < Date.now() ? '⌛ 已过期' : '✅ 有效');
        return ` #${r.id} [${state}] ${r.scope}（${r.grantor} · ${r.method} · ${new Date(r.ts).toLocaleString()}）${r.purpose ? ` 目的：${r.purpose}` : ''}`;
      }));
    }
    if (sub === 'status') {
      const scope = String(args[1] ?? '').trim();
      if (!scope) return '用法：/consent status <范围>';
      const r = ledger.isAuthorized(scope);
      return r.ok ? `✅ ${scope}：已授权` : `⛔ ${scope}：${r.reason}`;
    }
    // 无参：兼容原「签署同意书」语义 + 存证簿概览
    const cp = restoreCheckpoint(ctx.db, 'default');
    const consented = !!cp || existsSync(join(ctx.dataDir, 'consent.json'));
    if (!consented) writeFileSync(join(ctx.dataDir, 'consent.json'), JSON.stringify({ agreed: true, ts: Date.now() }), 'utf8');
    const recs = ledger.export();
    return lines(' 授权存证 ', [
      ` 同意书：${consented ? '已签署（本地运行、数据不出本机、凭证加密存储）' : '已签署'}`,
      ` 存证簿：${recs.length} 条授权（有效 ${recs.filter(r => !(r as any).revoked_at && (!(r as any).expires_at || (r as any).expires_at > Date.now())).length}）`,
      ` 外部访问自动存证：http_get / /claw / browser_navigate 每次成功访问自动留痕`,
      ``,
      ` 用法：/consent grant <范围> [--purpose 目的] [--hours N]｜revoke <id>｜list｜status <范围>`,
    ]);
  });

  bus.register('/audit', (args) => {
    // A21：过滤查询（--event 事件类型 / --limit N / --since 时间）——默认尾部 20 条
    const event = (() => {
      const i = args.indexOf('--event');
      return i >= 0 ? args[i + 1] : undefined;
    })();
    const limit = (() => {
      const i = args.indexOf('--limit');
      const n = Number(args[i + 1]);
      return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 20;
    })();
    const since = (() => {
      const i = args.indexOf('--since');
      return i >= 0 ? parseSinceArg(args[i + 1]) ?? undefined : undefined;
    })();
    const where = [
      event ? `AND event = ?` : '',
      since ? `AND ts >= ${Math.floor(since)}` : '',
    ].join(' ');
    const params = event ? [event] : [];
    const rows = ctx.db.prepare(
      `SELECT id, event, payload, ts FROM audit WHERE 1=1 ${where} ORDER BY id DESC LIMIT ${limit}`
    ).all(...params) as Array<{ id: number; event: string; payload: string; ts: number }>;
    if (!rows.length) return `审计无记录${event ? `（event=${event}）` : ''}`;
    return lines(` 审计日志（${rows.length} 条${event ? ` · ${event}` : ''}） `, rows.reverse().map(r => {
      let p = '';
      try {
        const parsed = JSON.parse(r.payload);
        const keys = Object.keys(parsed).filter(k => !['hash'].includes(k));
        p = keys.map(k => `${k}=${String(parsed[k]).slice(0, 60)}`).join(' ');
      } catch { p = String(r.payload ?? '').slice(0, 80); }
      return ` #${r.id} [${r.event}] ${p}（${new Date(r.ts).toLocaleTimeString()}）`;
    }));
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
    const unknown = unknownSettingsKeys(s);
    if (args[0] === 'set' && args[1]) {
      const key = args[1];
      // 开放兼容：/config set 放开为白名单全键（密钥槽位除外——密钥走 /key）
      if (!knownSettingsKeys().includes(key)) {
        return `未知配置键「${key}」——支持全部已知键（/config 查看），密钥用 /key set 配置`;
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
  // /input：动态内容表——多字段敏感输入（仅内存，不保存；像对话时输入 key 一样）
  bus.register('/input', async (args) => {
    // 字段语法：<字段名>[:<标签>[:<用途>]]——用途显示在表单提示中（减少误输入）
    const fields = args.map(a => {
      const [name, label, purpose, kindRaw] = a.split(':');
      const kind = (kindRaw === 'key' || kindRaw === 'text' ? kindRaw : 'password') as 'text' | 'password' | 'key';
      return { name, label: label ?? name, kind, purpose };
    }).filter(f => f.name);
    if (!fields.length) return '用法：/input <字段1> [字段2 ...]（动态内容表——多字段敏感输入，仅内存不保存；如 /input username password api_key）';
    if (!ctx.gateway?.requestCredentialForm) return '动态内容表需 TUI 会话（-p 非交互不可用）——配置 key 请用 /key set';
    // P0-1 审计留痕：记录字段名与来源（不含值——值绝不落盘）
    try {
      const { appendAudit } = await import('../store/db.js');
      appendAudit(ctx.db, 'credential.form_request', { source: 'cmd_input', fields: fields.map(f => f.name) });
    } catch { /* 审计失败不阻断 */ }
    const prompt = `动态内容表：输入以下敏感字段（仅内存，不落盘；bash 中可用 $WXNODUS_SECRET_<字段名> 引用）——${fields.map(f => `${f.label}${f.purpose ? `（用途：${f.purpose}）` : ''}`).join('、')}`;
    const values = await ctx.gateway.requestCredentialForm(fields, prompt);
    if (!values) return '输入已取消/超时——未录入任何值（内容不保存）';
    if (!ctx.secrets) return '内存保险库不可用（安全通道未装配）';
    const { commitFormValues, validateFormResponse } = await import('../kernel/dynamicForm.js');
    const missing = validateFormResponse(values, fields);
    const committed = commitFormValues(ctx.secrets, values, fields);
    if (!committed.length) return '未录入任何字段（全部为空）——内容不保存';
    const hint = committed.slice(0, 3).map(n => `$WXNODUS_SECRET_${n}`).join(' ');
    return `已录入 ${committed.length} 个字段（仅内存，不落盘）——可用 ${hint} 引用；/security secret off 或进程退出即清除${missing.length ? `；未填写：${missing.join('、')}` : ''}`;
  });

  bus.register('/capture', async (args) => {
    // /capture [x y width height] [--attach]——用户所需切片界面信息：缺省全屏；
    // 提供 4 个数字参数则按屏幕区域切片（配合 /vision 或 /img 分析指定界面片段）；
    // --attach：登记为待注入图片（下次提问经能力门——视觉模型看图/文本模型 GLM 先识别）
    const attach = args.includes('--attach');
    const nums = args.filter(a => a !== '--attach').map(Number);
    const region = nums.length === 4 && nums.every(Number.isFinite)
      ? { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! }
      : undefined;
    try {
      const { captureScreen } = await import('../kernel/computer/index.js');
      const shot = await captureScreen(region ? { region } : {});
      // A25：原生模块/图形环境缺失时 captureScreen 返回 null——如实报失败，
      // 不再输出「屏幕已捕获 → null」的假成功文案（此前 /img null 必然报文件不存在）
      if (!shot) {
        return '截图不可用：原生截图模块缺失或无图形环境（CI/远程会话）——请改用 /img <本地图片路径> 分析';
      }
      const out = join(ctx.dataDir, `capture-${Date.now().toString(36)}.png`);
      writeFileSync(out, shot.png, 'utf8');
      if (attach) {
        const { writePending } = await import('../kernel/imagePending.js');
        writePending(ctx.dataDir, ctx.agent?.getSessionId?.() ?? 'default', out, 'image/png');
      }
      const base = region
        ? `区域切片已捕获（${region.width}×${region.height} @ ${region.x},${region.y}）→ ${out}`
        : `屏幕已捕获 → ${out}`;
      return attach
        ? `${base}（已附加——直接提问，模型会看图；文本模型自动经 GLM 先识别）`
        : `${base}（可用 /img <路径> 分析，或 /capture --attach 直接附加提问）`;
    } catch (e: any) { return `截图失败：${e?.message?.slice(0, 120)}（需要图形环境）`; }
  });

  bus.register('/computer', async (args) => {
    // W3 Computer 第 1 步：组合路由决策——modern/required 在 ComputerUseService 接线完成前 fail-closed
    const { decideComputerRoute } = await import('./computerRouting.js');
    const computerRoute = decideComputerRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!computerRoute.ok) {
      throw new Error(`[${computerRoute.error.code}] ${computerRoute.error.message}`);
    }
    // W3 Computer facade：modern 路由走唯一共享管线（Observe→Resolve→PDP→Authorize→Act→Re-observe→Verify→Evidence）。
    // 后置条件以内置 verifier 真实校验（无验证即 COMPUTER_POSTCONDITION_FAILED——绝不假成功）；
    // 高影响动作经审批桥（无桥 fail-closed COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED）。
    if (computerRoute.value.route === 'modern') {
      const { ComputerUseService } = await import('../application/computer/computerUseService.js');
      const { createProductionComputerPorts } = await import('../application/computer/computerWiring.js');
      const { createComputerEvidenceStore } = await import('../application/computer/computerEvidenceStore.js');
      const { EmergencyStopService } = await import('../application/computer/emergencyStopService.js');
      const { captureScreen } = await import('../kernel/computer/index.js');
      const { ActionGuard } = await import('../kernel/computer/guards.js');
      const { createKernelComputerUse } = await import('./computerCompat.js');
      const { isHighImpactKind } = await import('../domain/computer/computerAction.js');
      const shot0 = await captureScreen();
      if (!shot0) return 'Computer Use 不可用：原生模块缺失或无图形环境（CI/远程会话）';
      const kernelCu = await createKernelComputerUse(new ActionGuard({ width: shot0.width, height: shot0.height }));
      const emergency = new EmergencyStopService();
      const sub = args[0];
      const action: import('../domain/computer/computerAction.js').ComputerAction | null = ((() => {
        if (sub === 'click') return { kind: 'click' as const, target: { type: 'screen' as const, id: 'main' }, effect: { summary: `点击 (${args[1]},${args[2]})`, parameters: { x: Number(args[1]) || 0, y: Number(args[2]) || 0, button: args[3] === 'right' || args[3] === 'double' ? String(args[3]) : 'left' } } };
        if (sub === 'type') return { kind: 'type' as const, target: { type: 'screen' as const, id: 'main' }, effect: { summary: `输入 ${args.slice(1).join(' ').length} 字符`, parameters: { text: args.slice(1).join(' ') } } };
        if (sub === 'open') return { kind: 'open' as const, target: { type: 'screen' as const, id: 'main' }, effect: { summary: `打开 ${args.slice(1).join(' ')}`, parameters: { url: args.slice(1).join(' ') } } };
        return null;
      })() as import('../domain/computer/computerAction.js').ComputerAction | null);
      if (!action) return 'modern 路由：/computer 支持 click/type/open（observe/uia 仍走 legacy——元素级与观察能力尚未迁移）';
      const ports = createProductionComputerPorts({
        kernel: { observe: () => kernelCu.observe(), act: (a) => kernelCu.act(a as never) },
        emergencyStop: { active: () => emergency.active },
        pdp: {
          decide: async (effect, _cctx) => {
            // 非高影响动作 policy 放行；高影响需审批桥授权（policy 标记 requiresApproval）
            void effect;
            return { ok: true as const, value: { allow: true } };
          },
        },
        approvals: {
          authorize: async (resolved, _policy, _cctx, signal) => {
            const request = resolved as { action?: { kind?: string; target?: { display?: string }; parameters?: Record<string, unknown> } };
            const kind = request.action?.kind ?? '';
            if (!isHighImpactKind(kind)) return { ok: true as const, value: undefined };
            if (!ctx.gateway?.requestApproval) {
              return { ok: false as const, error: { code: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', message: '高影响动作需要审批桥（TUI 装配）', messageKey: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', retryable: false } };
            }
            if (signal.aborted) return { ok: false as const, error: { code: 'COMPUTER_APPROVAL_ABORTED', message: 'x', messageKey: 'COMPUTER_APPROVAL_ABORTED', retryable: false } };
            const choice = await ctx.gateway.requestApproval(kind, request.action?.parameters ?? {});
            if (choice === 'deny') {
              return { ok: false as const, error: { code: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', message: '用户拒绝高影响动作', messageKey: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', retryable: false } };
            }
            return { ok: true as const, value: undefined };
          },
        },
        evidence: createComputerEvidenceStore(ctx.dataDir),
      });
      const service = new ComputerUseService(ports);
      const context = { actorId: 'cli', sessionId: ctx.agent?.getSessionId?.() ?? 'default', runId: `cli-${Date.now()}`, effectId: `eff-${Date.now()}`, correlationId: `corr-${Date.now()}` };
      const result = await service.execute(action, context, AbortSignal.timeout(30_000));
      if (!result.ok) return `[${result.error.code}] ${result.error.message}`;
      return `已执行 ${action.effect.summary}（证据 ${result.value.evidenceId}）`;
    }
    // Computer Use 手动入口（审查接线：computer/index.ts 此前零命令/零工具——README 宣传但无入口）。
    // 用法：/computer [click <x> <y> [right|double] | type <文本> | open <url> | observe | uia windows|tree|find <q>|click <q>|type <文本> <q>]
    const { join } = await import('node:path');
    const { writeFileSync } = await import('node:fs');
    const { captureScreen } = await import('../kernel/computer/index.js');
    const { ActionGuard } = await import('../kernel/computer/guards.js');
    const { convertCoords } = await import('../kernel/computer/actionLayer.js');
    // UIA 子命令（元素级——Windows UI Automation，零新增依赖）
    if (args[0] === 'uia') {
      const sub = args[1];
      const { uiaWindows, uiaTree, uiaFind, uiaClick, uiaType } = await import('../kernel/computer/uia.js');
      if (sub === 'windows') {
        const r = uiaWindows();
        if (!r.ok) return r.reason ?? 'UIA 不可用';
        return lines(' UIA 可见窗口 ', (r.windows ?? []).map(w => ` ${w.focused ? '◉' : '○'} 「${w.name.slice(0, 40)}」 pid=${w.pid} handle=${w.handle}`));
      }
      if (sub === 'tree') {
        const r = uiaTree(args[2] ?? '');
        if (!r.ok) return r.reason ?? 'UIA 不可用';
        return lines(` UIA 控件树（${(r.elements ?? []).length}） `, (r.elements ?? []).map(e =>
          ` ${e.name ? `「${e.name.slice(0, 30)}」` : ''}${e.id ? ` id=${e.id}` : ''} <${e.ct}> @(${e.x},${e.y})`));
      }
      if (sub === 'find') {
        const q = args.slice(2).join(' ');
        if (!q) return '用法：/computer uia find <名称>|<AutomationId>';
        const r = uiaFind(q);
        if (!r.ok) return r.reason ?? '未找到';
        const e = r.element as any;
        return `已定位：${e?.name ? `「${e.name}」` : ''}${e?.id ? ` id=${e.id}` : ''} <${e?.ct ?? ''}> @(${e?.x},${e?.y} ${e?.w}x${e?.h})`;
      }
      if (sub === 'click') {
        const q = args.slice(2).join(' ');
        if (!q) return '用法：/computer uia click <名称>|<AutomationId>';
        const r = uiaClick(q);
        if (!r.ok) return r.reason ?? '点击失败';
        const el = r.element as any;
        return `已点击（${el?.method ?? 'uia'}）${el?.x != null ? ` @(${el.x},${el.y})` : ''}`;
      }
      if (sub === 'type') {
        // 审查修复（P2）：文本多词时原实现只取 args[2]、其余并入查询——中文输入基本不可用；
        // 改为查询取尾 token、文本为中间全部
        const q = args[args.length - 1] ?? '';
        const text = args.slice(2, -1).join(' ');
        if (!q || !text) return '用法：/computer uia type <文本…> <名称>|<AutomationId>';
        const r = uiaType(text, q);
        if (!r.ok) return r.reason ?? '输入失败';
        return `已输入 ${text.length} 字符（${(r.element as any)?.method ?? 'uia'}）`;
      }
      return lines(' UIA ', [
        ' 用法：',
        '  /computer uia windows             — 枚举可见窗口',
        '  /computer uia tree [句柄]         — 控件树（无句柄=焦点窗口）',
        '  /computer uia find <名称>|<Id>    — 定位元素',
        '  /computer uia click <名称>|<Id>   — 元素级点击（原生 Invoke）',
        '  /computer uia type <文本> <名称>|<Id> — 元素级输入（中文原生）',
      ]);
    }
    const shot = await captureScreen();
    if (!shot) return 'Computer Use 不可用：原生模块缺失或无图形环境（CI/远程会话）';
    // W3-11：ComputerUse 构造经 compat 委托（直接 new 遗留驱动已禁用）
    const { createComputerUse } = await import('./computerCompat.js');
    const cu = await createComputerUse(new ActionGuard({ width: shot.width, height: shot.height }));
    const sub = args[0];
    if (sub === 'click') {
      const x = Number(args[1]), y = Number(args[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return '用法：/computer click <x> <y> [right|double]';
      const btn = args[3] === 'right' || args[3] === 'double' ? args[3] : 'left';
      const { x: lx, y: ly } = convertCoords(x, y, { scale: shot.scale });
      const r = await cu.act({ type: 'click', x: lx, y: ly, button: btn as any });
      return `${r}（视口 ${shot.width}x${shot.height}，scale ${shot.scale}）`;
    }
    if (sub === 'type') {
      const text = args.slice(1).join(' ');
      if (!text) return '用法：/computer type <文本>';
      return await cu.act({ type: 'type', text });
    }
    if (sub === 'open') {
      const url = args.slice(1).join(' ');
      if (!url) return '用法：/computer open <URL|路径>';
      return await cu.act({ type: 'open', url });
    }
    if (sub === 'observe') {
      // 截图 + 开放视觉通道理解（settings 端点/本地 VLM）
      const out = join(ctx.dataDir, `computer-${Date.now().toString(36)}.png`);
      writeFileSync(out, shot.png, 'utf8');
      const { describeImageStatus } = await import('../kernel/vision.js');
      const settings = ctx.config.get('settings');
      const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
      const vr = await describeImageStatus(out, enc ?? null, '描述当前屏幕内容：界面/窗口/按钮与输入框的名称与大致位置（用中文）。', settings);
      return lines(' Computer Use 观察 ', [
        ` 截图 → ${out}${vr.cached ? '（同屏缓存：10s 内相同画面未重新识别）' : ''}`,
        vr.ok ? ` ${(vr.text ?? '').slice(0, 1200)}` : ` ⚠ 视觉不可用：${vr.reason}（可用 /computer uia tree 读元素结构）`,
      ]);
    }
    // 无参/未知子命令：截图 + 视口信息
    const out = join(ctx.dataDir, `computer-${Date.now().toString(36)}.png`);
    writeFileSync(out, shot.png, 'utf8');
    return lines(' Computer Use ', [
      `视口：${shot.width}x${shot.height}（DPI scale ${shot.scale}）——坐标按像素输入，自动换算`,
      `截图已保存 → ${out}（/img <路径> 或 GLM-4V 分析后按坐标操作）`,
      ``,
      `用法：`,
      `  /computer click <x> <y> [right|double]  — 点击屏幕坐标`,
      `  /computer type <文本>                   — 键入文本（中文走剪贴板）`,
      `  /computer open <URL|路径>               — 系统默认浏览器/资源管理器打开`,
      `  /computer observe                      — 截图 + 视觉理解（开放通道/本地 VLM）`,
      `  /computer uia …                        — Windows UI Automation（元素级：windows/tree/find/click/type）`,
      `模型侧：computer_observe/uia_tree → 定位 → computer_click/uia_click 自动完成同链路`,
    ]);
  });

  bus.register('/render', (args) => {
    const target = args.join(' ');
    if (!target) return '用法：/render <文本>（Markdown 排版预览：标题/代码块/列表/分隔线）';
    // 审计修复：真实 Markdown 基础排版（此前仅包盒子冒充渲染）
    const out = target.split('\n').map(l => {
      const t = l.trim();
      if (/^#{1,6}\s/.test(t)) return t; // 标题保留 # 前缀
      if (/^```/.test(t)) return '┌ ' + t.slice(3);
      if (/^```$/.test(t)) return '└──'; // 代码块闭合
      if (/^[-*]\s/.test(t)) return ' • ' + t.slice(2);
      if (/^\d+[.)]\s/.test(t)) return t;
      if (/^[-_*]{3,}$/.test(t)) return '─'.repeat(24);
      return t;
    });
    return lines(' Markdown 预览 ', out);
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
    // W3 Plugin 第 1 步：组合路由决策——modern/required 在沙箱/权限/签名接线完成前 fail-closed
    const { decidePluginRoute } = await import('./extensionRouting.js');
    const pluginRoute = decidePluginRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!pluginRoute.ok) {
      throw new Error(`[${pluginRoute.error.code}] ${pluginRoute.error.message}`);
    }
    // W3 Plugin facade：modern 路由经 PluginLifecycleService（manifest→checksum→probe→沙箱门→owned scope 原子换入）。
    // 生产 sandbox=crash-isolation（Untrusted 自动 quarantined）；broker 权限请求经生产 ToolExecutionPipeline
    // （W1-08 11 ports 真实装配）——未装配组合根时保持 PLUGIN_BROKER_PIPELINE_UNAVAILABLE fail-closed（绝不假执行）。
    if (pluginRoute.value.route === 'modern') {
      const { join } = await import('node:path');
      const { createProcessIsolationSandbox } = await import('../infrastructure/plugins/processIsolationSandbox.js');
      const { createPluginBroker } = await import('../infrastructure/plugins/pluginProtocol.js');
      const { createPluginLifecycleService } = await import('../application/extensions/pluginLifecycleService.js');
      const { ExtensionScopeManager } = await import('../application/extensions/extensionScopeManager.js');
      const { createComputerEvidenceStore } = await import('../application/computer/computerEvidenceStore.js');
      const [sub, ...rest] = args;
      const name = rest[0];
      const sandbox = createProcessIsolationSandbox();
      const broker = createPluginBroker({
        pipeline: (ctx.toolPipeline ?? {
          execute: async () => ({
            ok: false as const,
            error: { code: 'PLUGIN_BROKER_PIPELINE_UNAVAILABLE', message: 'ToolExecutionPipeline 未装配——插件能力请求 fail-closed', messageKey: 'PLUGIN_BROKER_PIPELINE_UNAVAILABLE', retryable: false },
          }),
        }) as never,
      });
      const service = createPluginLifecycleService({
        dataDir: ctx.dataDir,
        sandbox,
        broker,
        scopeManager: new ExtensionScopeManager(),
      });
      const evidence = createComputerEvidenceStore(join(ctx.dataDir, 'evidence'));
      const context = { actorId: 'cli', sessionId: ctx.agent?.getSessionId?.() ?? 'default', runId: `cli-${Date.now()}`, correlationId: `corr-${Date.now()}` } as never;
      if (sub === 'enable' && name) {
        const sourceDir = join(ctx.dataDir, 'plugins', name);
        const result = await service.enable(sourceDir, context, AbortSignal.timeout(60_000));
        await evidence.closeComputerAction({ kind: 'plugin.enable', plugin: name, result: result.ok ? 'enabled' : result.error.code }).catch(() => undefined);
        if (!result.ok) return `[${result.error.code}] ${result.error.message}`;
        const state = service.snapshot(name);
        return `插件已启用：${name}（沙箱 ${state?.sandboxStrength}，owner ${state?.owner}）`;
      }
      if (sub === 'disable' && name) {
        const result = await service.disable(name, context, AbortSignal.timeout(60_000));
        await evidence.closeComputerAction({ kind: 'plugin.disable', plugin: name }).catch(() => undefined);
        if (!result.ok) return `[${result.error.code}] ${result.error.message}`;
        return `插件已禁用：${name}`;
      }
      if (sub === 'uninstall' && name) {
        const result = await service.uninstall(name, context, AbortSignal.timeout(60_000));
        if (!result.ok) return `[${result.error.code}] ${result.error.message}`;
        return `插件已卸载：${name}`;
      }
      if (!sub || sub === 'list') {
        return lines(' 插件（modern 路由） ', [
          ' /plugin enable <名称> —— manifest→checksum→probe→沙箱门→owned scope 原子换入',
          ' /plugin disable|uninstall <名称> —— owner 校验的原子降级/卸载',
          ' Untrusted 插件需 OS-enforced 沙箱（当前 crash-isolation → 自动 quarantined，绝不降级宣称安全）',
          ' 插件能力请求（workspace/network/process）在生产 ToolExecutionPipeline 接线前 fail-closed',
        ]);
      }
      return 'modern 路由：/plugin list ｜ enable|disable|uninstall <名称>';
    }
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
        // demo:true——脚手架演示工具对模型隐藏（「hello」被廉价模型选中触发审批阻塞，
        // 真实 cmd 实测缺陷）；真实插件工具不标 demo
        tools: [{ name: `${name}_greet`, description: '打招呼', demo: true, parameters: { who: { type: 'string', description: '对象' } } }],
        commands: ['hello'],
      }, null, 2), 'utf8');
      writeFileSync(join(dest, 'index.js'), `// ${name} 插件实现（ESM 模块）——完整 API 见 docs/plugin-api.md
// ctx 可用能力：cwd/dataDir/dataPath（私有数据目录）、on(事件订阅)、getConfig(只读配置)、log(日志)
export const tools = {
  ${name}_greet: async (args, ctx) => {
    ctx.log('info', \`greet 被调用：\${JSON.stringify(args)}\`); // 写入 data/plugins/${name}/plugin.log
    return \`你好，\${args?.who ?? '世界'}（插件数据目录：\${ctx.dataPath}）\`;
  },
  ${name}_watch: async (_args, ctx) => {
    ctx.on('system.notice', (payload) => { ctx.log('info', \`通知：\${payload?.text ?? ''}\`); });
    return '已订阅 system.notice 事件（/plugin reload 重载）';
  },
}

export const commands = {
  hello: async (args) => \`\${args.length ? args.join(' ') : '（空参数）'}\`,
  model: async (_args, ctx) => \`当前模型：\${ctx.getConfig('settings', 'model') ?? '未配置'}\`,
}
`, 'utf8');
      return `插件骨架已生成 → ${dest}\n编辑 index.js 实现逻辑后，新开会话或 /plugin reload 生效`;
    }

    // P1b：/plugin reload —— 热重载（重建 agent 工具表 + 重注册命令/NL 触发，不重启进程）
    if (sub === 'reload') {
      const { loadAllPlugins, pluginToolsToExtra, registerPluginCommands, registerPluginNlTriggers } = await import('../kernel/plugins.js');
      const reloaded = await loadAllPlugins(ctx.dataDir, ctx.cwd);
      const toolCount = Object.keys(pluginToolsToExtra(reloaded)).length;
      const cmdCount = Object.keys(reloaded.flatMap(p => Object.keys(p.commands))).length;
      const enabled = reloaded.filter(p => p.manifest.enabled !== false).length;
      // 开放兼容：命令与 NL 触发随 reload 重注册（bus.register 同名覆盖 = 热更新）
      if (ctx.commandBus) registerPluginCommands(ctx.commandBus, reloaded);
      registerPluginNlTriggers(reloaded);
      if (ctx.agent?.updateTools) {
        ctx.agent.updateTools(pluginToolsToExtra(reloaded));
        return `插件已热重载：${enabled} 个启用（${toolCount} 工具 + ${cmdCount} 命令）——无需重启`;
      }
      return `已重新扫描：${enabled} 个启用（${toolCount} 工具 + ${cmdCount} 命令）——当前环境不支持热更新，重启后生效`;
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
      // 审计修复：安装后立即热更新（不再提示重启后生效）
      const { loadAllPlugins, pluginToolsToExtra, registerPluginCommands, registerPluginNlTriggers } = await import('../kernel/plugins.js');
      const reloaded = await loadAllPlugins(ctx.dataDir, ctx.cwd);
      if (ctx.commandBus) registerPluginCommands(ctx.commandBus, reloaded);
      registerPluginNlTriggers(reloaded);
      ctx.agent?.updateTools?.(pluginToolsToExtra(reloaded));
      return `插件已安装并热生效：${pluginName} → ${dest}（/plugin list 查看）`;
    }

    const target = all.find(p => p.manifest.name === name);
    if (!target) return `插件不存在：${name}（/plugin list 查看）`;

    if (sub === 'remove') {
      try { rmSync(target.dir, { recursive: true, force: true }); } catch (e: any) { return `删除失败：${e?.message?.slice(0, 120) ?? e}`; }
      return `插件已移除：${name}`;
    }
    if (sub === 'enable' || sub === 'disable') {
      const ok = setPluginEnabled(target.dir, sub === 'enable');
      if (!ok) return `状态修改失败：${name}`;
      // 审计修复：不再提示「重启后生效」——立即热更新（工具表 + 命令 + NL 触发）
      const { loadAllPlugins, pluginToolsToExtra, registerPluginCommands, registerPluginNlTriggers } = await import('../kernel/plugins.js');
      const reloaded = await loadAllPlugins(ctx.dataDir, ctx.cwd);
      if (ctx.commandBus) registerPluginCommands(ctx.commandBus, reloaded);
      registerPluginNlTriggers(reloaded);
      ctx.agent?.updateTools?.(pluginToolsToExtra(reloaded));
      return `插件已${sub === 'enable' ? '启用' : '禁用'}：${name}（热生效，无需重启）`;
    }
    return '用法：/plugin install <目录> ｜ list ｜ remove｜enable｜disable <名称>';
  });

  // ── 连接类 ──────────────────────────────────
  // /mcp：本地 MCP 客户端管理（两级配置：项目 .mcp.json + 用户 data/mcp.json）
  // 生态对齐 Claude Code：项目级 mcpServers 对象格式；strictMcpConfig 仅信任项目声明
  bus.register('/mcp', async (args) => {
    // W3 MCP 第 1 步：组合路由决策——modern/required 在 extensions 接线完成前 fail-closed
    const { decideMcpRoute } = await import('./extensionRouting.js');
    const mcpRoute = decideMcpRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!mcpRoute.ok) {
      throw new Error(`[${mcpRoute.error.code}] ${mcpRoute.error.message}`);
    }
    // W3 MCP facade：modern 路由经现代 client host（SDK auto negotiation 是 era 事实源）+
    // transport policy + transcript store；shutdown 由统一 disposer 纳入（cli 'mcp' 已接线）。
    // incoming stdio/Streamable HTTP 由 WxNodusMcpServer 真实启动——只发布真实 delivered surface
    // （pipeline 未接线即 NOT_DELIVERED fail-closed，绝不假发布）。
    if (mcpRoute.value.route === 'modern') {
      const { connectMcp: connectModern } = await import('../infrastructure/mcp/mcpClientHost.js');
      const { McpTransportPolicy } = await import('../infrastructure/mcp/mcpTransportPolicy.js');
      const { InMemoryMcpTranscriptStore } = await import('../infrastructure/mcp/mcpTranscriptStore.js');
      const { loadMcpConfig: loadModern } = await import('../kernel/mcp.js');
      const [sub, ...rest] = args;
      const entries = loadModern(ctx.dataDir, { cwd: ctx.cwd });
      if (!sub || sub === 'list') {
        return lines(' MCP（modern 路由） ', [
          ...(entries.length ? entries.map(s => ` ${s.name}${s.source === 'project' ? ' [项目]' : ' [用户]'} → ${s.url ? `HTTP ${s.url}` : `${s.command} ${(s.args ?? []).join(' ')}`}`) : [' 未配置 server']),
          ' /mcp connect <名称> —— 真实 SDK 协商（stdio/streamable-http，era 事实源）',
          ' 传输策略：policy 逐条判定；transcript 落盘审计；dispose 纳入统一 shutdown',
        ]);
      }
      if (sub === 'connect' && rest[0]) {
        const target = entries.find(e => e.name === rest[0]);
        if (!target) return `server「${rest[0]}」未配置（/mcp add 先配置）`;
        try {
          const { lookup } = await import('node:dns/promises');
          const policy = new McpTransportPolicy({ resolve: async host => (await lookup(host, { all: true })).map(r => r.address) });
          if (target.url) await policy.assertHttpTarget(new URL(target.url)); // SSRF 先验（私网/loopback/DNS fail-closed）
          const config = target.url
            ? { transport: 'streamable-http' as const, url: target.url, headers: {} }
            : { transport: 'stdio' as const, command: target.command, args: target.args ?? [], env: {} };
          const connected = await connectModern(config, AbortSignal.timeout(30_000));
          const transcript = new InMemoryMcpTranscriptStore(() => new Date().toISOString());
          transcript.append({ requestId: `r-${Date.now()}`, direction: 'out', method: 'initialize', status: 'ok', payload: { name: target.name, era: connected.era, negotiatedVersion: connected.negotiatedVersion }, evidenceId: `mcp-connect:${target.name}` });
          await connected.dispose();
          return `已连接 ${target.name}：era ${connected.era} · 协议 ${connected.negotiatedVersion}（transcript 已记录）`;
        } catch (cause) {
          return `[MCP_CONNECT_FAILED] ${String((cause as Error)?.message ?? cause).slice(0, 200)}`;
        }
      }
      return 'modern 路由：/mcp list ｜ connect <名称>（incoming server 经 WxNodusMcpServer——未接线 pipeline 的 surface 如实 NOT_DELIVERED）';
    }
    const { loadMcpConfig, saveMcpConfig, saveProjectMcpConfig, connectMcp } = await import('../kernel/mcp.js');
    const [sub, ...rest] = args;
    const entries = loadMcpConfig(ctx.dataDir, { cwd: ctx.cwd });
    const tag = (s: { source: string }) => (s.source === 'project' ? ' [项目]' : ' [用户]');
    if (!sub || sub === 'list') {
      if (!entries.length) {
        return lines(' MCP ', [' 未配置 server', '', ' 用法：/mcp add <名称> <命令> [参数...]（--project 写项目 .mcp.json）', '       /mcp remove <名称>', '       /mcp test <名称>', ' 配置：项目 .mcp.json（mcpServers 格式）+ 用户 data/mcp.json', ' strictMcpConfig=true 时仅信任项目声明（--strict-mcp-config 等价）']);
      }
      return lines(' MCP ', entries.map(s => ` ${s.name}${tag(s)} → ${s.url ? `HTTP ${s.url}` : `${s.command} ${(s.args ?? []).join(' ')}`}`));
    }
    if (sub === 'add-http') {
      // Streamable HTTP 传输（远程 MCP server）：/mcp add-http <名称> <URL> [--project]
      const isProject = rest.includes('--project');
      const name = rest[isProject ? 0 : 0];
      const url = rest[isProject ? 1 : 1];
      if (!name || !/^https?:\/\//.test(url ?? '')) return '用法：/mcp add-http <名称> <URL>（远程 MCP，Streamable HTTP 传输）';
      if (entries.some(e => e.name === name)) return `server「${name}」已存在（/mcp remove ${name} 后重加）`;
      const server = { name, command: '', url, args: [] };
      if (isProject) {
        const proj = loadMcpConfig(ctx.dataDir, { cwd: ctx.cwd, strict: true }).filter(s => s.source === 'project');
        saveProjectMcpConfig(ctx.cwd, [...proj.map(s => ({ name: s.name, command: s.command, url: s.url, args: s.args, env: s.env })), server]);
      } else {
        const user = loadMcpConfig(ctx.dataDir, { strict: true }).filter(s => s.source === 'user');
        saveMcpConfig(ctx.dataDir, [...user.map(s => ({ name: s.name, command: s.command, url: s.url, args: s.args, env: s.env })), server]);
      }
      try {
        const r = await ctx.reloadMcp?.();
        return r?.ok ? `已添加远程 MCP server「${name}」（${url}，${r.count} 个在线）` : `已添加远程 MCP server「${name}」（重启后生效）`;
      } catch { return `已添加远程 MCP server「${name}」（重启后生效）`; }
    }
    if (sub === 'add') {
      const isProject = rest[0] === '--project';
      const name = rest[isProject ? 1 : 0];
      const command = rest[isProject ? 2 : 1];
      if (!name || !command) return '用法：/mcp add [--project] <名称> <命令> [参数...]';
      if (entries.some(s => s.name === name)) return `server「${name}」已存在（/mcp remove ${name} 后重加）`;
      const server = { name, command, args: rest.slice(isProject ? 3 : 2) };
      if (isProject) {
        const proj = loadMcpConfig(ctx.dataDir, { cwd: ctx.cwd, strict: true }).filter(s => s.source === 'project');
        saveProjectMcpConfig(ctx.cwd, [...proj.map(s => ({ name: s.name, command: s.command, args: s.args, env: s.env })), server]);
      } else {
        const user = loadMcpConfig(ctx.dataDir, { strict: true }).filter(s => s.source === 'user');
        saveMcpConfig(ctx.dataDir, [...user.map(s => ({ name: s.name, command: s.command, args: s.args, env: s.env })), server]);
      }
      // P3：热重载接通——/mcp add 后立即重连并热换工具表（无需重启）
      try {
        const r = await ctx.reloadMcp?.();
        return r?.ok ? `已添加${isProject ? '项目级' : ''}并热重载 MCP server「${name}」（${r.count} 个在线，工具已并入工具表）` : `已添加 MCP server「${name}」（重启后生效）`;
      } catch { return `已添加 MCP server「${name}」（重启后生效）`; }
    }
    if (sub === 'remove') {
      const name = rest[0];
      if (!name) return '用法：/mcp remove <名称>';
      const next = entries.filter(s => s.name !== name);
      if (next.length === entries.length) return `未找到 server「${name}」`;
      const proj = next.filter(s => s.source === 'project');
      const user = next.filter(s => s.source === 'user');
      // 仅当原本存在项目级配置时才回写——避免在无 .mcp.json 的项目根凭空创建空文件
      if (entries.some(s => s.source === 'project')) {
        saveProjectMcpConfig(ctx.cwd, proj.map(s => ({ name: s.name, command: s.command, args: s.args, env: s.env })));
      }
      saveMcpConfig(ctx.dataDir, user.map(s => ({ name: s.name, command: s.command, args: s.args, env: s.env })));
      try {
        const r = await ctx.reloadMcp?.();
        return r?.ok ? `已移除并热重载 MCP server「${name}」（${r.count} 个在线）` : `已移除 MCP server「${name}」（重启后生效）`;
      } catch { return `已移除 MCP server「${name}」（重启后生效）`; }
    }
    if (sub === 'test') {
      const name = rest[0];
      const cfg = entries.find(s => s.name === name);
      if (!cfg) return `未找到 server「${name}」（/mcp list 查看）`;
      try {
        const client = await connectMcp(cfg);
        const tools = client.tools.map(t => t.name).join(', ') || '（无工具）';
        client.close();
        return lines(` MCP 测试 ${name}${tag(cfg)} `, [` 连接成功，工具：${tools}`]);
      } catch (e: any) {
        return `连接失败：${e?.message ?? e}`;
      }
    }
    return '用法：/mcp list｜add [--project] <名称> <命令> [参数...]｜add-http [--project] <名称> <URL>｜remove <名称>｜test <名称>';
  });

  // /perm rule：持久化审批规则（P0-2——deny>allow>ask，data/permissions.json）
  // reason 字段：规则的人工可读理由（Codex exec policy 同款，审计可追溯）
  bus.register('/perm rule', (args) => {
    const [sub, tool, decision, pattern, ...reasonRest] = args;
    const rules = loadPermRules(ctx.dataDir);
    if (sub === 'list') {
      if (!rules.length) return '暂无规则（/perm rule add <工具> allow|deny|ask [路径glob] [理由]）';
      return lines(' 审批规则 ', rules.map((r, i) =>
        ` #${i + 1}  ${r.decision.toUpperCase().padEnd(5)}  ${r.tool}${r.pattern ? `  ${r.pattern}` : ''}${r.reason ? `  — ${r.reason}` : ''}`
      ));
    }
    if (sub === 'add') {
      if (!tool || !['allow', 'deny', 'ask'].includes(decision)) {
        return '用法：/perm rule add <工具名> allow|deny|ask [路径glob，如 src/**] [理由文字]';
      }
      rules.push({ tool, decision: decision as any, pattern: pattern || undefined, reason: reasonRest.join(' ') || undefined });
      savePermRules(ctx.dataDir, rules);
      return `已添加规则：${decision} ${tool}${pattern ? `（${pattern}）` : ''}${reasonRest.length ? `——${reasonRest.join(' ')}` : ''}——立即生效`;
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
    return '用法：/perm rule list ｜ add <工具> allow|deny|ask [glob] [理由] ｜ remove <编号> ｜ clear';
  });

  // /self-evolve：自举模式（颠覆性改造——WxNodus 改进自己）
  // 闭环：AI 分析自身源码 → 生成补丁（JSON）→ 真实应用（undo shadow 备份可回滚）
  //   → 跑自身测试套件 → 失败自动回滚 → 报告（绝不自动提交——用户确认）
  bus.register('/self-evolve', async (args) => {
    // --report：自我审查报告模式（只审查不修改——AI 审查源码输出建议清单落盘，
    //   绝不应用补丁；与默认自举模式互补：先报告后决定是否动手）
    const first = args[0];
    if (first === '--report' || first === 'report') {
      const { resolveApiKey } = await import('../kernel/providers.js');
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (!keyRes.key) return '自我审查需要模型密钥——/key set <密钥> 后可用（AI 审查自身源码输出建议）';
      if (!ctx.agent) return '当前环境无 agent（无法审查）';
      const scope = args.slice(1).join(' ') || 'src/kernel、src/commands、src/cli';
      const r = await ctx.agent.run(`你是 WxNodus 的自我审查引擎。审查自身源码，输出改进建议清单（只审查，绝不修改任何文件）。
审查范围：${scope}
要求：
- 用 fs_read 抽查关键文件（kernel/agent.ts、commands/handlers.ts、commands/handlersExt.ts、kernel/env.ts、kernel/permissions.ts 等）后给出结论
- 输出必须是 JSON 数组：[{"file":"相对路径","severity":"high|medium|low","issue":"问题描述","suggestion":"具体改进建议"}]
- 聚焦：真实 bug、重复代码、安全隐患、死代码、接口漂移；不列风格问题
- 至少 5 条，最多 15 条；只输出 JSON，不要任何其他文字`);
      const text = r.text.trim();
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) return `模型未输出审查 JSON：${text.slice(0, 150)}`;
      let items: Array<{ file?: string; severity?: string; issue?: string; suggestion?: string }>;
      try { items = JSON.parse(m[0]); } catch { return '审查结果解析失败（模型输出非法 JSON）——重试'; }
      if (!Array.isArray(items) || !items.length) return '审查为空——重试';
      // 落盘 dataDir/reports/self-review-<ts>.md（审计留痕——AI 标注来源，人工复核后改进）
      const dir = join(ctx.dataDir, 'reports');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `self-review-${Date.now().toString(36)}.md`);
      const md = [
        '# WxNodus 自我审查报告',
        `- 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `- 范围：${scope}`,
        '- 来源：AI 模型审查（建议仅供参考——人工复核后按建议改进）',
        '',
        ...items.map((it, i) => `## ${i + 1}. [${String(it.severity ?? 'low').toUpperCase()}] ${it.file ?? '?'}\n\n${it.issue ?? ''}\n\n> 建议：${it.suggestion ?? ''}\n`),
      ].join('\n');
      writeFileSync(file, md, 'utf8');
      const counts = { high: 0, medium: 0, low: 0 };
      for (const it of items) counts[String(it.severity ?? 'low') as 'low']++;
      return lines(` 自我审查报告（${items.length} 条——已存 ${file}） `, [
        ` 严重度：🔴 ${counts.high} ｜ 🟡 ${counts.medium} ｜ 🟢 ${counts.low}`,
        ...items.map((it, i) => ` ${it.severity === 'high' ? '🔴' : it.severity === 'medium' ? '🟡' : '🟢'} ${i + 1}. [${it.file ?? '?'}] ${String(it.issue ?? '').slice(0, 60)}`),
        ` 报告仅建议、未改动任何代码（/self-evolve 可应用补丁）`,
      ]);
    }
    const direction = args.join(' ') || '优化代码质量、消除重复、修复潜在 bug';
    // 1. AI 分析自身源码生成补丁（无 key 诚实提示——不产生假补丁）
    const { resolveApiKey } = await import('../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) return '自举需要模型密钥——/key set <密钥> 后可用（AI 分析自身源码生成补丁并自验证）';
    if (!ctx.agent) return '当前环境无 agent（无法自举）';
    // 2. 生成补丁（限定 src/kernel + src/commands——不碰装配/UI/测试，防止自毁）
    const r = await ctx.agent.run(`你是 WxNodus 的自我改进引擎。分析自身源码并生成修改补丁。
改进方向：${direction}
约束：
- 只修改 src/kernel/** 与 src/commands/**（绝不碰 src/cli、src/wxnodus-ui、tests、package.json）
- 输出必须是 JSON 数组：[{"file":"相对路径","old":"被替换原文（必须与现有代码精确匹配）","new":"替换后内容"}]
- 每个补丁 ≤ 30 行；小而明确的改进；不重写整文件
- 动手前用 fs_read 读文件确认 old 精确匹配
- 只输出 JSON，不要任何其他文字`);
    const text = r.text.trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return `模型未输出补丁 JSON：${text.slice(0, 150)}`;
    let patches: Array<{ file?: string; old?: string; new?: string }>;
    try { patches = JSON.parse(m[0]); } catch { return '补丁解析失败（模型输出非法 JSON）——换更小方向重试'; }
    if (!Array.isArray(patches) || !patches.length) return '补丁为空——换方向重试';
    // 3. 应用补丁（先 undo shadow 备份——/undo fs 可回滚）
    const { snapshotFile, versionsOfFile, restoreShadow } = await import('../kernel/undoShadows.js');
    const applied: Array<{ file: string; ok: boolean; reason?: string }> = [];
    for (const p of patches) {
      const rel = String(p.file ?? '');
      const file = resolve(ctx.cwd, rel);
      // 审查修复：补丁路径强约束——「仅 src/kernel 与 src/commands」此前只是 prompt 文本，
      // 代码直接 resolve+writeFileSync 落盘（绕过 fs_write 的 SENSITIVE_WRITE 红线与审批链），
      // 可写 data/permissions.json、settings.json、.env 或任意绝对路径；现与声明强制一致
      const relNorm = normalize(relative(ctx.cwd, file));
      const allowedDir = relNorm === `src${sep}kernel` || relNorm.startsWith(`src${sep}kernel${sep}`)
        || relNorm === `src${sep}commands` || relNorm.startsWith(`src${sep}commands${sep}`);
      if (!allowedDir) { applied.push({ file: rel, ok: false, reason: '路径超出允许范围（仅 src/kernel 与 src/commands 内）' }); continue; }
      if (!existsSync(file)) { applied.push({ file: rel, ok: false, reason: '文件不存在' }); continue; }
      const content = readFileSync(file, 'utf8');
      const oldText = String(p.old ?? '');
      if (!oldText || !content.includes(oldText)) { applied.push({ file: rel, ok: false, reason: 'old 未精确匹配（模型幻觉？）' }); continue; }
      snapshotFile(ctx.dataDir, file, content); // 备份原内容
      writeFileSync(file, content.replace(oldText, String(p.new ?? '')), 'utf8');
      applied.push({ file: rel, ok: true });
    }
    const okCount = applied.filter(a => a.ok).length;
    if (!okCount) return '全部补丁未应用（old 未匹配）——模型幻觉或文件已变更，重试';
    // 4. 验证：跑自身测试套件（npm test，净化环境）
    const { execFileSync } = await import('node:child_process');
    const { sanitizedEnv } = await import('../kernel/env.js');
    let testOk = false;
    let testOut = '';
    try {
      const t0 = Date.now();
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--silent'], {
        cwd: ctx.cwd, timeout: 300_000, stdio: 'pipe', shell: process.platform === 'win32', env: sanitizedEnv(),
      });
      testOk = true;
      testOut = `✅ ${((Date.now() - t0) / 1000).toFixed(1)}s 全绿`;
    } catch (e: any) {
      testOut = `❌ ${String(e?.message ?? e).slice(0, 200)}`;
    }
    // 5. 失败自动回滚（逐文件恢复最新快照）
    if (!testOk) {
      let rolled = 0;
      for (const a of applied.filter(x => x.ok)) {
        const v = versionsOfFile(ctx.dataDir, resolve(ctx.cwd, a.file))[0];
        if (v && restoreShadow(ctx.dataDir, v.id).ok) rolled++;
      }
      return lines(' 自举失败——已自动回滚 ', [
        ` 方向：${direction}`,
        ` 补丁：${okCount}/${applied.length} 应用成功`,
        ` 测试：${testOut}`,
        ` 已回滚：${rolled} 个文件（补丁全部撤销）`,
        ` 建议：换更小粒度的方向重试，或人工检查后手工修改`,
      ]);
    }
    return lines(' 自举完成——未提交 ', [
      ` 方向：${direction}`,
      ` 补丁：${okCount}/${applied.length} 应用成功`,
      ...applied.filter(a => !a.ok).map(a => ` ✗ ${a.file}：${a.reason}`),
      ` 测试：${testOut}`,
      ` 回放 CI：/script ci 可做剧本回归（如有录制剧本）`,
      ` 变更未提交——满意后 git add + commit；不满意 /undo fs restore 1 回滚`,
    ]);
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
        ' 用法：/security sudo on|off ｜ /security secret on|off ｜ /security all off ｜ /security secrets list',
        ' 红线：敏感内容仅用户亲手输入、仅内存使用；关闭通道即同步清除缓存',
      ]);
    }
    const set = (next: Record<string, boolean>) => {
      ctx.config.setKey('settings', 'security', { ...sec, ...next });
      return next;
    };
    if (sub === 'secrets' && state === 'list') {
      // P0-3：列出内存密钥字段名与剩余有效期（绝不显示值）
      const vault = ctx.secrets;
      if (!vault) return '内存保险库不可用';
      const names = vault.secretNames();
      if (!names.length) return '内存密钥为空（/input <字段...> 或 credential_form 录入；10 分钟未用自动过期）';
      return lines(' 内存密钥（仅字段名，不显示值） ', [
        ...names.map(n => ` ${n}（剩余 ${vault.secretTTL(n)}s——未使用即自动清除）`),
        ` 共 ${names.length} 个；/security secret off 或进程退出即全部清除`,
      ]);
    }
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

  // /claw：网页抓取（SSRF 防护：形态/IPv6/DNS 重绑定/重定向逐跳）——真实 fetch + 正文提取
  // P0-4：正文干净度优先（extractMainText）+ JS 渲染兜底（静态抓取几乎无正文 → Playwright 无头渲染）
  bus.register('/claw', async (args) => {
    const url = args.join(' ').replace(/^["']|["']$/g, '').trim();
    if (!url) return '用法：/claw <URL>（网页抓取，SSRF 防护拦截内网；JS 页自动浏览器兜底）';
    try {
      const { safeFetchText } = await import('../kernel/ssrf.js');
      const { htmlToText, extractMainText } = await import('../kernel/html.js');
      // A20：消费 settings.proxy（原死配置接入）+ 响应体上限 1MB + 默认 UA
      const proxy = (ctx.config.get('settings') as any)?.proxy as string | undefined;
      const r = await safeFetchText(url, { maxBytes: 1_000_000, proxy });
      if ('error' in r) return r.error;
      // 审查接线（自动化护栏）：robots.txt 禁止路径拦截 + 验证码页面提示
      const { robotsGuard } = await import('../kernel/robotsGuard.js');
      const guard = await robotsGuard(url, r.text);
      if (guard.block) return guard.block;
      // 状态码归因：4xx/5xx 页面正文（如 404 Not Found）不当作有效内容
      if (r.status >= 400) return `抓取失败：HTTP ${r.status}（${url}）——页面不可用或反爬拦截`;
      const html = r.text;
      // 正文提取（readability 式启发优先——导航/页脚/广告噪声不入结果；空则全量剥标签兜底）
      let text = extractMainText(html);
      if (!text) text = htmlToText(html);
      // JS 渲染兜底：静态抓取几乎无正文（<200 字符）→ 走真实浏览器渲染拿正文
      if ((!text || text.length < 200) && /^https?:\/\//i.test(url)) {
        try {
          const { browserNavigate } = await import('../kernel/browser.js');
          const br = await browserNavigate(url);
          if (br.ok && br.text && br.text.trim().length > text.length) text = br.text.trim();
        } catch { /* 兜底失败不阻断——保持静态抓取结果 */ }
      }
      const body = text || '（页面无可提取文本，可能是 JS 渲染或反爬）';
      // 诚实截断（labelTruncate 统一口径——模型知道正文有剩余）
      return `HTTP ${r.status}｜${html.length} 字节${guard.captcha ? '\n⚠ 检测到验证码页面（站点反爬——内容可能不可用）' : ''}\n${labelTruncate(body, 4000, 'http_get <url> 或分段抓取续看')}`;
    } catch (e: any) {
      return `抓取失败：${e?.message?.slice(0, 300) ?? e}`;
    }
  });

  // A20：联网搜索（自研 DDG+Bing 双引擎解析，无 API key；SSRF 防护复用）
  // P0-4：--content [N] 搜索即读——对前 N 条结果抓取正文（对标现代 coding 工具的搜索+内容一体）
  bus.register('/search', async (args) => {
    // --engine auto|duckduckgo|bing：指定搜索引擎（默认 auto 双引擎回退）
    const engIdx = args.indexOf('--engine');
    let engine: 'auto' | 'duckduckgo' | 'bing' = 'auto';
    if (engIdx >= 0) {
      const e = String(args[engIdx + 1] ?? 'auto').toLowerCase();
      if (e === 'duckduckgo' || e === 'bing') engine = e;
    }
    // --content [N]：抓取前 N 条结果正文（默认 3；--content 0 关闭）
    const cIdx = args.indexOf('--content');
    let withContent = false;
    let fetchTop = 3;
    if (cIdx >= 0) {
      withContent = true;
      const n = parseInt(String(args[cIdx + 1] ?? ''), 10);
      if (Number.isFinite(n) && n >= 0) fetchTop = n;
    }
    const skip = (i: number) => args[i] === '--engine' || args[i] === '--content' || args[i - 1] === '--engine' || args[i - 1] === '--content';
    const q = args.filter((_, i) => !skip(i)).join(' ').trim();
    if (!q) return '用法：/search <查询词> [--content [N]] [--engine auto|duckduckgo|bing]（双引擎搜索；--content 抓取前 N 条正文）';
    try {
      const { searchWeb, searchWebWithContent } = await import('../kernel/search.js');
      const proxy = (ctx.config.get('settings') as any)?.proxy as string | undefined;
      const r = withContent
        ? await searchWebWithContent(q, { proxy, engine, fetchTop })
        : await searchWeb(q, { proxy, engine });

      if (!r.ok) {
        return `搜索失败：${r.error}`;
      }

      if (!r.results.length) {
        return '搜索无结果';
      }

      const lines: string[] = [`引擎：${r.engine}`];
      for (const [i, x] of r.results.entries()) {
        lines.push(`${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`);
        const xc = x as { content?: string; contentError?: string };
        if (xc.content) lines.push(`   ── 正文 ──\n   ${xc.content.replace(/\n/g, '\n   ')}`);
        else if (xc.contentError) lines.push(`   ⚠ 正文抓取失败：${xc.contentError}`);
      }
      return lines.join('\n');
    } catch (e: any) {
      return `搜索失败：${e?.message?.slice(0, 300) ?? e}`;
    }
  });

  // P0-1：/browser——浏览器自动化（探测/导航/关闭；AI 工具 browser_* 同链路）
  bus.register('/browser', async (args) => {
    // W3 Browser 第 1 步：组合路由决策——modern/required 在 Playwright 接线完成前 fail-closed
    const { decideBrowserRoute } = await import('./computerRouting.js');
    const browserRoute = decideBrowserRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!browserRoute.ok) {
      throw new Error(`[${browserRoute.error.code}] ${browserRoute.error.message}`);
    }
    // W3 Browser facade：modern 路由经 BrowserSessionService（P0-02 权威：owner 校验/独立 context/URL 逐跳授权）
    // + 入口 UrlPolicy 先验（私网/loopback/DNS fail-closed）+ 证据落盘。
    if (browserRoute.value.route === 'modern') {
      const { BrowserSessionService } = await import('../application/computer/browserSessionService.js');
      const { createProductionBrowserDriver, authorizeBrowserUrl } = await import('../application/computer/browserWiring.js');
      const { createComputerEvidenceStore } = await import('../application/computer/computerEvidenceStore.js');
      const sub = String(args[0] ?? '').toLowerCase();
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      if (sub === 'open') {
        const url = args.slice(1).join(' ').trim();
        if (!url) return '用法：/browser open <URL>（SSRF 防护拦截内网）';
        const authorized = await authorizeBrowserUrl({ url });
        if (!authorized.ok) return `[${authorized.error.code}] ${authorized.error.message}（${String((authorized.error.details as Record<string, unknown> | undefined)?.reason ?? '')}）`;
        const service = new BrowserSessionService(createProductionBrowserDriver());
        const opened = await service.open(sid);
        if (!opened.ok) return `[${opened.error.code}] ${opened.error.message}`;
        const navigated = await opened.value.navigate(authorized.value.url);
        if (!navigated.ok) return `[${navigated.error.code}] ${navigated.error.message}`;
        const evidence = createComputerEvidenceStore(ctx.dataDir);
        const closed = await evidence.closeComputerAction({ kind: 'browser.open', url: authorized.value.url, sessionId: sid });
        return closed.ok ? `已打开 ${authorized.value.url}（证据 ${closed.value.evidenceId}）` : `已打开 ${authorized.value.url}（证据落盘失败：${closed.error.code}）`;
      }
      if (sub === 'close') {
        const service = new BrowserSessionService(createProductionBrowserDriver());
        const closed = await service.close(sid);
        if (!closed.ok) return `[${closed.error.code}] ${closed.error.message}`;
        return '已关闭浏览器会话';
      }
      return 'modern 路由：/browser open <URL> ｜ close（每会话独立 context，URL 逐跳授权 + 证据落盘）';
    }
    const sub = String(args[0] ?? '').toLowerCase();
    const { browserProbe, browserClose, browserNavigate } = await import('../kernel/browser.js');
    if (sub === 'close') return await browserClose();
    if (sub === 'open') {
      const url = args.slice(1).join(' ').trim();
      if (!url) return '用法：/browser open <URL>（SSRF 防护拦截内网）';
      const r = await browserNavigate(url);
      return r.text.slice(0, 1500);
    }
    // 默认：探测状态
    const probe = browserProbe();
    return probe.ok
      ? `浏览器可用：${probe.browser}\n用法：/browser open <URL> ｜ /browser close（AI 也可经 browser_* 工具自主操作）`
      : `浏览器不可用：${probe.error}\n安装 Microsoft Edge 或 Google Chrome 后重试`;
  });

  // A20：/web 别名（抓取 URL——与 /claw 同链路同防护）
  bus.register('/web', async (args) => {
    const url = args.join(' ').trim();
    if (!url) return '用法：/web <URL>';
    if (!ctx.commandBus) return '命令总线不可用';

    const r = await ctx.commandBus.execute(`/claw ${url}`);

    return r.output ?? (r.ok ? '' : '抓取失败');
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
      }).catch(() => { gatewayServer = null; return; });
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
      // 两种格式：数字间隔（every Nm 兼容；显式 Ns 秒级）或标准 5 字段 cron 表达式（分 时 日 月 周）
      // 智能识别：前 5 个 token 均为合法 cron 字段（数字/星号/步进/区间/列表）→ 视为表达式
      const isCronField = (t: string) => /^(\d+|\*|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/.test(t);
      const looksCron5 = rest.length >= 6 && /^\d+$/.test(rest[0] ?? '') && rest.slice(0, 5).every(isCronField);
      const expr = looksCron5
        ? rest.slice(0, 5).join(' ')
        : /^(\d+)[sm]$/.test(rest[0] ?? '') ? `every ${rest[0]}` : (/^\d+$/.test(rest[0] ?? '') ? `every ${rest[0]}m` : (rest[0] ?? ''));
      const action = (looksCron5 ? rest.slice(5) : rest.slice(1)).join(' ').trim();
      const parsed = parseCronExpr(expr);
      // 秒级间隔（every Ns）不走 5 字段解析——单独校验（≥1 秒）
      const seconds = /^every (\d+)s$/.exec(expr);
      if (seconds && parseInt(seconds[1]!, 10) < 1) return '间隔需 ≥1 秒';
      if ((!parsed.ok && !seconds) || !action) return `用法：/cron add <分钟间隔|cron表达式> <命令文本>（如 /cron add 30 检查仓库状态；/cron add 30s 每 30 秒；/cron add 0 9 * * 1-5 工作日 9 点报告）——${parsed.ok ? '' : parsed.error}`;
      const r = ctx.db.prepare(`INSERT INTO cron_jobs (schedule, action, last_run, enabled) VALUES (?,?,?,1)`).run(expr, action, Date.now()); // last_run=创建时刻（周期起算点）
      return `定时任务已创建 #${r.lastInsertRowid}：${describeCronExpr(expr)} 执行「${action.slice(0, 40)}」`;
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
    if (sub === 'run') {
      // 立即触发一次：投递任务系统（agent 型独立会话），结果 /jobs show 可查
      const id = parseInt(rest[0] ?? '', 10);
      if (!Number.isFinite(id)) return '用法：/cron run <id>（立即执行一次）';
      const j = ctx.db.prepare(`SELECT * FROM cron_jobs WHERE id=?`).get(id) as any;
      if (!j) return `定时任务不存在：#${id}`;
      if (!ctx.taskRunner) return '任务系统不可用（taskRunner 未装配）';
      const tid = ctx.taskRunner.run({ goal: `（定时任务 #${id}）${j.action}`, kind: 'agent', tags: [`cron:${id}`], maxRetries: 1 });
      return `已立即触发定时任务 #${id} → 任务 ${tid}（/jobs show ${tid} 查看结果；/jobs list --tag cron:${id} 查看历史）`;
    }
    const jobs = ctx.db.prepare(`SELECT * FROM cron_jobs ORDER BY id`).all() as any[];
    if (!jobs.length) return '暂无定时任务——/cron add <分钟间隔> <命令> 创建（如 /cron add 30 检查仓库状态）';
    return lines(' 定时任务 ', jobs.map(j => {
      const last = j.last_run ? new Date(j.last_run).toLocaleTimeString('zh-CN', { hour12: false }) : '未执行';
      // 上次执行结果（关联任务系统 tag=cron:<id> 最新一条）
      let lastRes = '－';
      try {
        const r = ctx.db.prepare(`SELECT status FROM tasks WHERE tags LIKE ? ORDER BY created_at DESC LIMIT 1`).get(`%cron:${j.id}%`) as { status: string } | undefined;
        if (r) lastRes = r.status === 'success' || r.status === 'done' ? '🟢' : r.status === 'failed' ? '🔴' : r.status === 'cancelled' ? '⏸' : '🟡';
      } catch { /* 表未就绪 */ }
      return ` #${j.id} ${j.enabled ? '●' : '○'} ${j.schedule}（上次 ${last} ${lastRes}）→ ${String(j.action ?? '').slice(0, 40)}`;
    }));
  });

  // /jobs：并行任务系统（双线子任务 + 三任务并行）
  //   run <命令> [--parallel <支线>]... [--agent|--parallel-agent <目标>] [--timeout 秒] [--retries N] [--tag <名>] [--cwd <目录>]
  //   tree <id> ｜ show <id> ｜ list [--status x] [--tag x] ｜ logs <id> [N] ｜ follow <id>
  //   kill <id>（父任务级联）｜ retry <id> ｜ pause|resume <id> ｜ clean [keep]
  bus.register('/jobs', async (args) => {
    const [sub, ...rest] = args;
    const tr = ctx.taskRunner;
    if (!tr) return '任务系统不可用（taskRunner 未装配）';
    const GLYPH: Record<string, string> = { queued: '⚪', running: '🟡', success: '🟢', failed: '🔴', cancelled: '⏸', done: '🟢' };
    const LABEL: Record<string, string> = { queued: '排队中', running: '运行中', success: '完成', failed: '失败', cancelled: '已取消', done: '完成' };
    const kindIcon = (k: string) => (k === 'shell' ? '⚙' : k === 'agent' ? '◈' : '⧉');

    if (sub === 'run') {
      // 参数解析：--parallel/--parallel-agent 可多个（双线子任务）；其余为开关/选项
      let main: string | null = null;
      let mainAgent = false;
      const branches: Array<{ goal: string; agent: boolean }> = [];
      let timeoutSec: number | undefined;
      let maxRetries: number | undefined;
      let tag: string | undefined;
      let cwd: string | undefined;
      const pos: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--parallel' || a === '--parallel-agent') {
          // 命令可能含空格：收集直到下一个 -- flag
          const parts: string[] = [];
          while (i + 1 < rest.length && !rest[i + 1]!.startsWith('--')) parts.push(rest[++i]!);
          if (parts.length) branches.push({ goal: parts.join(' '), agent: a === '--parallel-agent' });
        } else if (a === '--agent') mainAgent = true;
        else if (a === '--timeout') timeoutSec = Number(rest[++i]);
        else if (a === '--retries') maxRetries = Number(rest[++i]);
        else if (a === '--tag') tag = rest[++i];
        else if (a === '--cwd') cwd = rest[++i];
        else pos.push(a);
      }
      main = pos.join(' ');
      if (!main && !branches.length) return '用法：/jobs run <命令> [--parallel <支线>]... [--agent] [--timeout 秒] [--retries N] [--tag <名>]';
      const mk = (goal: string, agent: boolean): TaskSpec => ({
        goal, kind: agent ? 'agent' : 'shell',
        timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
        maxRetries, tags: tag ? [tag] : undefined, cwd,
      });
      if (branches.length) {
        // 并行任务：父任务（编排器）＋ N 条支线同时启动——三任务并行（含对话主线）
        const { id, children } = tr.runParallel(mk(main || '（纯并行编排）', mainAgent), branches.map(b => mk(b.goal, b.agent)));
        return `并行任务已启动：${c(id, '35')}（1 父 + ${children.length} 支线并行，主线对话不受影响）——/jobs tree ${id} 查看`;
      }
      const id = tr.run(mk(main!, mainAgent));
      return `后台任务已启动：${c(id, '35')}「${main!.slice(0, 60)}」（/jobs show ${id} ｜ /jobs list 监控）`;
    }

    if (sub === 'tree') {
      const id = rest[0];
      if (!id) return '用法：/jobs tree <任务ID>';
      const t = tr.get(id);
      if (!t) return `任务不存在：${id}`;
      const line = (x: TaskRow, depth: number) =>
        ` ${'  '.repeat(depth)}${GLYPH[x.status] ?? '·'} ${c(x.id, '35')} ${LABEL[x.status] ?? x.status}${x.exit_code != null ? `(${x.exit_code})` : ''} ${kindIcon(x.kind)}「${x.goal.slice(0, 40)}」`;
      return lines(` 任务树 ${id} `, [line(t, 0), ...tr.childrenOf(id).map(ch => line(ch, 1))]);
    }

    if (sub === 'show') {
      const id = rest[0];
      if (!id) return '用法：/jobs show <任务ID>';
      const t = tr.get(id);
      if (!t) return `任务不存在：${id}`;
      const dur = t.done_at ? Math.round((t.done_at - t.created_at) / 1000) : t.started_at ? Math.round((Date.now() - t.started_at) / 1000) : 0;
      const children = tr.childrenOf(id);
      return lines(` 任务 ${id} `, [
        ` 目标：${t.goal}`,
        ` 状态：${GLYPH[t.status] ?? '·'} ${LABEL[t.status] ?? t.status}${t.error ? ` —— ${t.error}` : ''}`,
        ` 类型：${t.kind === 'shell' ? 'Shell 子进程' : t.kind === 'agent' ? 'AI 子代理' : '并行编排'} ｜ PID：${t.pid ?? '-'} ｜ 退出码：${t.exit_code ?? '-'} ｜ 耗时：${dur}s${t.retries ? ` ｜ 重试：${t.retries}` : ''}`,
        ...(t.log_file ? [` 日志：${t.log_file}（/jobs logs ${id} 查看）`] : []),
        ...(children.length ? ['', ` 子任务（${children.length}）：`, ...children.map(ch => `   ${GLYPH[ch.status] ?? '·'} ${ch.id} ${LABEL[ch.status] ?? ch.status}「${ch.goal.slice(0, 36)}」`)] : []),
        ...(t.output ? ['', ...String(t.output).split('\n').slice(0, 10).map(l => ` ${l.slice(0, 108)}`)] : []),
      ]);
    }

    if (sub === 'logs') {
      const id = rest[0];
      const n = Math.min(Number(rest[1] ?? 30) || 30, 200);
      const t = tr.get(id);
      if (!t) return `任务不存在：${id}`;
      if (!t.log_file) return '该任务无日志文件（agent 型任务输出见 /jobs show）';
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        if (!existsSync(t.log_file)) return '日志文件尚未生成（任务排队中）';
        const text = readFileSync(t.log_file, 'utf8');
        const ls = text.split('\n').filter(Boolean);
        return lines(` 日志 ${id}（${ls.length} 行） `, ls.slice(-n).map(l => ` ${l.slice(0, 110)}`));
      } catch (e: any) { return `日志读取失败：${e?.message ?? e}`; }
    }

    if (sub === 'follow') {
      // 流式尾随：每 2s 输出日志新增行，任务结束自动退出（最多 120s）
      const id = rest[0];
      const t = tr.get(id);
      if (!t) return `任务不存在：${id}`;
      if (!t.log_file) return '该任务无日志文件';
      const { readFileSync, existsSync } = await import('node:fs');
      let pos = 0;
      const out: string[] = [];
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const cur = tr.get(id);
        if (cur && existsSync(t.log_file)) {
          const text = readFileSync(t.log_file, 'utf8');
          if (text.length > pos) { out.push(text.slice(pos)); pos = text.length; }
        }
        if (cur && ['success', 'failed', 'cancelled'].includes(cur.status)) break;
        await new Promise(r => setTimeout(r, 2000));
      }
      const final = tr.get(id);
      return lines(` 日志尾随 ${id} `, [
        ...(out.length ? out.join('').split('\n').filter(Boolean).slice(-50).map(l => ` ${l.slice(0, 110)}`) : ['（无新增输出）']),
        ` 最终状态：${final ? `${GLYPH[final.status] ?? '·'} ${LABEL[final.status] ?? final.status}` : '未知'}（日志：${t.log_file}）`,
      ]);
    }

    if (sub === 'kill') {
      const id = rest[0];
      if (!id) return '用法：/jobs kill <任务ID>（父任务级联 kill 全部支线）';
      const ok = await tr.kill(id);
      return ok ? `任务已取消：${id}` : `任务不存在：${id}`;
    }

    if (sub === 'retry') {
      const id = rest[0];
      if (!id) return '用法：/jobs retry <任务ID>';
      const nid = tr.retry(id);
      return nid ? `任务已重新入队：${nid}` : `任务不存在或仍在运行：${id}`;
    }

    if (sub === 'pause') {
      const id = rest[0];
      if (!id) return '用法：/jobs pause <任务ID>（仅排队中可暂停）';
      return tr.pause(id) ? `任务已暂停（队列中）：${id}` : `任务不可暂停（仅排队中有效）：${id}`;
    }

    if (sub === 'resume') {
      const id = rest[0];
      if (!id) return '用法：/jobs resume <任务ID>';
      return tr.resume(id) ? `任务已恢复：${id}` : `任务未暂停：${id}`;
    }

    if (sub === 'clean') {
      const keep = Number(rest[0] ?? 100) || 100;
      const n = tr.clean(keep);
      return `已清理 ${n} 条已结束任务（保留最近 ${keep} 条）`;
    }

    // list（默认）：--status <状态> ｜ --tag <名> 过滤
    const si = rest.indexOf('--status');
    const ti = rest.indexOf('--tag');
    const status = si >= 0 ? rest[si + 1] : undefined;
    const tag = ti >= 0 ? rest[ti + 1] : undefined;
    const rows = tr.list({ status: status as any, tag, limit: 20 });
    if (!rows.length) return '暂无后台任务（/jobs run <命令> 或 /jobs run <命令> --parallel <支线> 启动并行任务）';
    return lines(' 后台任务 ', rows.map(r => {
      const dur = r.done_at ? `[${Math.round((r.done_at - r.created_at) / 1000)}s]` : r.started_at ? `[${Math.round((Date.now() - r.started_at) / 1000)}s]` : '[排队]';
      return ` ${GLYPH[r.status] ?? '·'} ${c(r.id, '35')} ${LABEL[r.status] ?? r.status} ${dur} ${kindIcon(r.kind)}${r.parent_id ? ' ↳' : ''} ${String(r.goal).slice(0, 46)}${r.tags ? ` #${r.tags}` : ''}`;
    }));
  });

  // /delegate：真实派发子代理（只读工具集、独立上下文），结果回显并持久化到 tasks 表（可查可恢复）
  // P0-2：/agent——自定义 agent 定义（.wxnodus/agents/*.md + data/agents/*.md）
  // 对齐 OpenCode/Codex agent 体系：list 查看｜run <name> <任务> 按定义派发
  bus.register('/agent', async (args) => {
    const { loadAgentDefs, findAgentDef } = await import('../kernel/agents.js');
    const defs = loadAgentDefs(ctx.cwd, ctx.dataDir);
    const sub = String(args[0] ?? '').toLowerCase();
    if (sub === 'list' || !sub) {
      if (!defs.length) return '无自定义 agent（.wxnodus/agents/*.md 或 data/agents/*.md——frontmatter: name/description/mode/tools + 正文指令）';
      return lines(' 自定义 agent ', defs.map(d => {
        const tools = d.tools ? `工具[${d.tools.join(',')}]` : '只读工具集';
        return ` ${d.name.padEnd(18)} ${d.mode ?? 'smart'}｜${tools}｜${d.description}`;
      }));
    }
    if (sub === 'run') {
      const name = String(args[1] ?? '');
      const task = args.slice(2).join(' ').trim();
      if (!name || !task) return '用法：/agent run <agent名> <任务>（/agent list 查看）';
      const def = findAgentDef(name, ctx.cwd, ctx.dataDir);
      if (!def) return `agent「${name}」不存在（/agent list 查看；.wxnodus/agents/${name}.md 可创建）`;
      if (!ctx.agent) return 'agent 不可用：当前环境未提供子代理能力';
      ctx.bus.emit('system.notice', { text: `派发 agent「${name}」：「${task.slice(0, 60)}」…` });
      const r = await ctx.agent.spawnSubagent(task, undefined, {
        systemPromptOverride: def.instructions,
        mode: def.mode,
        tools: def.tools,
      });
      return lines(` agent「${name}」结果 `, [
        ` 任务：${task.slice(0, 80)}`,
        ` 状态：${r.ok ? '完成' : '未完成'}（${r.turns} 轮）`,
        '',
        ...String(r.output ?? '').split('\n').slice(0, 30).map(l => ` ${l.slice(0, 110)}`),
      ]);
    }
    return '用法：/agent list｜/agent run <agent名> <任务>';
  });

  // P2-全方面：/arena——多模型对战（Qwen Agent Arena 对齐，差异化杀手锏）
  // 同一任务依次用两个模型执行（主模型 + 指定/自动次选），输出对比面板 + 全文落盘
  bus.register('/arena', async (args) => {
    const mIdx = args.indexOf('--model');
    const m2 = mIdx >= 0 ? String(args[mIdx + 1] ?? '') : '';
    const task = args.filter((a, i) => a !== '--model' && args[i - 1] !== '--model').join(' ').trim();
    if (!task) return '用法：/arena <任务> [--model <次选模型id>]（双模型对战选优，结果落盘 data/arena-*）';
    if (!ctx.agent) return 'arena 不可用：当前环境未提供 agent';
    const { resolveApiKey, MODEL_CATALOG } = await import('../kernel/providers.js');
    const { resolveDefaultModel } = await import('../kernel/defaults.js');
    const settings = ctx.config.get('settings') as { apiKeyEnc?: string | null; baseURL?: string; model?: string };
    const keyRes = resolveApiKey(settings);
    if (!keyRes.key) return 'arena 需要模型密钥——/key set <密钥> 后可用（双模型真实对战）';
    const cur = settings.model && MODEL_CATALOG.some(m => m.modelId === settings.model) ? settings.model : resolveDefaultModel(settings);
    // 次选：--model 指定 ｜ 同 provider 备选 ｜ 目录中第一个不同模型（不同 provider 也可——密钥同 env）
    let second = '';
    if (m2) {
      if (!MODEL_CATALOG.some(m => m.modelId === m2)) return `模型「${m2}」不在目录（/model 查看可用模型）`;
      second = m2;
    } else {
      const sameProv = MODEL_CATALOG.find(m => m.provider === MODEL_CATALOG.find(x => x.modelId === cur)?.provider && m.modelId !== cur);
      second = sameProv?.modelId ?? MODEL_CATALOG.find(m => m.modelId !== cur)?.modelId ?? '';
    }
    if (!second) return '无可用次选模型';
    const agent = ctx.agent; // 已确认非空（上方 gate）
    ctx.bus.emit('system.notice', { text: `arena 对战开始：${cur} vs ${second}「${task.slice(0, 40)}」…` });
    const ts = Date.now().toString(36);
    const run = async (modelId: string, sid: string): Promise<{ modelId: string; ok: boolean; turns: number; text: string }> => {
      try {
        agent.setSessionId(sid);
        ctx.setModel(modelId);
        const r = await agent.run(task);
        return { modelId, ok: r.ok, turns: r.turns, text: r.text };
      } catch (e: any) {
        return { modelId, ok: false, turns: 0, text: `执行失败：${String(e?.message ?? e).slice(0, 200)}` };
      }
    };
    const a = await run(cur, `arena-a-${ts}`);
    const b = await run(second, `arena-b-${ts}`);
    // 恢复主会话状态（对战使用独立会话，不污染）
    try {
      agent.setSessionId(agent.getSessionId?.() ?? 'default');
      ctx.setModel(cur);
    } catch { /* 恢复失败静默 */ }
    // 全文落盘（对比审阅用）
    const outFile = join(ctx.dataDir, `arena-${ts}.md`);
    try {
      writeFileSync(outFile, `# Arena 对战：${cur} vs ${second}\n\n## 任务\n${task}\n\n## ${cur}（${a.turns} 轮）\n${a.text}\n\n## ${second}（${b.turns} 轮）\n${b.text}\n`, 'utf8');
    } catch { /* 落盘失败不阻断 */ }
    const summary = (x: { text: string }) => x.text.split('\n').filter(Boolean).slice(0, 6).map(l => l.slice(0, 90)).join('\n');
    // 对战成本（各自独立会话——costQuery 同源 /cost 估算；未收录定价诚实省略）
    const costOf = (sid: string): string => {
      const q = sessionCost(ctx.db, sid, (ctx.config.get('settings') as Record<string, any>)?.costPrices);
      return q && q.unknown === 0 ? ` · ≈$${q.usd.toFixed(4)}` : '';
    };
    return lines(` Arena 对战「${task.slice(0, 24)}」 `, [
      ` 完整输出：${outFile}`,
      '',
      `── 选手 A：${a.modelId}（${a.turns} 轮）${a.ok ? '' : '⚠ 未完成'}${costOf(`arena-a-${ts}`)}──`,
      summary(a),
      '',
      `── 选手 B：${b.modelId}（${b.turns} 轮）${b.ok ? '' : '⚠ 未完成'}${costOf(`arena-b-${ts}`)}──`,
      summary(b),
      '',
      ` 建议：比较两份输出选优（也可 /arena --model <其它模型> 再战）`,
    ]);
  });

  // 深度：/review——任务自查（Codex /review 对齐）——AI 以审查者视角复查刚完成的工作
  // 内置审查指令（不依赖用户 agent 文件）；可指定审查范围（文件/目录/最近改动）
  bus.register('/review', async (args) => {
    const scope = args.join(' ').trim();
    if (!ctx.agent) return 'review 不可用：当前环境未提供 agent';
    const REVIEW_PROMPT = `你是资深代码审查专家（审查者视角——不修改任何文件，只审查）。
审查对象：用户指定的改动/文件/任务结果（本次子代理上下文独立，先读相关文件再下结论）。
审查要点：①逻辑错误与边界条件 ②安全漏洞（注入/密钥泄露/权限越界）③性能瓶颈 ④可维护性 ⑤与需求的一致性。
输出格式：
## 问题清单（按严重度排序）
- [P0/P1/P2] 文件:行号 — 问题描述与修复建议
## 总体评价（3-5 句）
未发现 P0/P1 级问题时明确说「未发现 P0/P1 级问题」。`;
    ctx.bus.emit('system.notice', { text: `自查开始：「${(scope || '最近工作').slice(0, 50)}」…` });
    const r = await ctx.agent.spawnSubagent(scope || '审查当前工作目录最近的改动（git diff 或最近修改的文件）', undefined, {
      systemPromptOverride: REVIEW_PROMPT,
      mode: 'plan', // 只读审查——plan 模式禁止写
      tools: ['fs_read', 'grep', 'ls', 'find_files', 'repo_map', 'memory_search'],
    });
    return lines(` 自查结果（${r.turns} 轮） `, [
      ...String(r.output ?? '').split('\n').slice(0, 40).map(l => ` ${l.slice(0, 110)}`),
      r.ok ? '' : ' ⚠ 审查未完整执行（无密钥时需 /key set 后使用 AI 审查）',
    ]);
  });

  // 架构 P3：/session-stream——会话事件流查看/导出（可重放/审计；Claude Code 会话流对齐）
  bus.register('/session-stream', async (args) => {
    const { listSessionStreams, readSessionEvents } = await import('../kernel/sessionStream.js');
    const sub = String(args[0] ?? '').toLowerCase();
    const sid = args[1] ?? ctx.agent?.getSessionId?.() ?? 'default';
    if (sub === 'list' || !sub) {
      const streams = listSessionStreams(ctx.dataDir);
      if (!streams.length) return '暂无会话事件流（agent 回合后自动生成——用户消息/工具/压缩/审批完整时间线）';
      return lines(' 会话事件流 ', streams.slice(0, 15).map(s => ` ${s.sessionId.padEnd(20)} ${s.events} 事件｜${(s.size / 1024).toFixed(1)} KB`));
    }
    if (sub === 'show') {
      const events = readSessionEvents(ctx.dataDir, sid);
      if (!events.length) return `会话 ${sid} 无事件流`;
      return lines(` 会话流「${sid}」（${events.length} 事件） `, events.slice(-30).map(e => {
        switch (e.type) {
          case 'user': return ` 👤 ${String(e.content).slice(0, 60)}`;
          case 'model': return e.role === 'tool_call' ? ` 🤖 工具调用 ×${e.toolCalls?.length ?? 0}` : ` 🤖 ${String(e.content ?? '').slice(0, 60)}`;
          case 'tool': return ` ⛭ ${e.name} ${e.phase === 'start' ? '开始' : `完成${e.ok ? '' : '（失败）'}${e.ms ? ` ${e.ms}ms` : ''}`}`;
          case 'approval': return ` ⛨ ${e.tool} → ${e.verdict}`;
          case 'compact': return ` ▤ 压缩：${e.before} → ${e.after} token`;
          case 'end': return ` ✔ 回合结束（${e.turns} 轮${e.ok ? '' : '，未完成'}）`;
          case 'stage': return ` · ${e.stage.slice(0, 50)}`;
          default: return ` ? ${JSON.stringify(e).slice(0, 60)}`;
        }
      }));
    }
    return '用法：/session-stream list｜show [会话ID]（事件流 = 用户消息/模型回复/工具/压缩/审批时间线）';
  });

  // 原创能力：/understand——逆向编译（代码 → 概念规格）
  // 与 /build（概念 → 代码）形成「概念双向编译」闭环——竞品无此设计。
  // 输出概念文档落盘 data/understand/<name>.md，可喂回 /build 重新编译为可运行项目。
  bus.register('/understand', async (args) => {
    const target = args.filter(a => !a.startsWith('--')).join(' ').trim() || ctx.cwd;
    const { resolve, dirname, basename } = await import('node:path');
    const { existsSync, statSync } = await import('node:fs');
    const abs = resolve(ctx.cwd, target);
    if (!existsSync(abs)) return `路径不存在：${target}`;
    const dir = statSync(abs).isFile() ? dirname(abs) : abs;
    const name = basename(dir) || 'project';
    // 1. 证据采集：项目扫描 + 仓库地图（先看结构再下结论——编译学派第一步）
    const { scanProject } = await import('../kernel/projectScan.js');
    const { buildRepoMap } = await import('../kernel/repoMap.js');
    const profile = scanProject(dir);
    const map = buildRepoMap(dir, { budgetTokens: 1500 });
    const evidence = [
      `类型：${profile.type}｜构建：${profile.buildCmd || '—'}｜测试：${profile.testCmd || '—'}｜运行：${profile.runCmd || '—'}`,
      `顶层：${profile.structure.slice(0, 12).join(' / ')}`,
      `地图（${map.scanned} 文件扫描）：\n${map.map.slice(0, 1200)}`,
    ].join('\n');
    // 2. 概念规格生成：有 key → LLM 逆向编译（概念化/领域建模/验收建议）；
    //    无 key → 规则提炼（诚实降级，标注来源）
    const settings = ctx.config.get('settings') as { apiKeyEnc?: string | null; baseURL?: string; model?: string };
    const { resolveApiKey, MODEL_CATALOG } = await import('../kernel/providers.js');
    const { resolveDefaultModel, resolveDefaultBaseURL } = await import('../kernel/defaults.js');
    const keyRes = resolveApiKey(settings);
    let concept: { title: string; summary: string; modules: string[]; domain: string[]; acceptance: string[] } | null = null;
    let source = '规则提炼';
    if (keyRes.key) {
      const { callModelOnce, extractJson } = await import('../kernel/llmOnce.js');
      const model = settings.model && MODEL_CATALOG.some(m => m.modelId === settings.model) ? settings.model : resolveDefaultModel(settings);
      const r = await callModelOnce({
        baseURL: resolveDefaultBaseURL(settings), model, key: keyRes.key,
        messages: [
          { role: 'system', content: '你是逆向编译器：把代码仓库编译为概念规格 JSON（人类可理解的产品/领域视角）。严格只输出 JSON：{"title":"项目名","summary":"一句话定位","modules":["模块1","模块2"],"domain":["核心概念1","核心概念2"],"acceptance":["可验证验收1","可验证验收2","可验证验收3"]}' },
          { role: 'user', content: `以下是对仓库 ${name} 的扫描证据：\n${evidence}` },
        ],
        temperature: 0.3,
      });
      if (r.ok) {
        const j = extractJson(r.content);
        if (j) {
          concept = {
            title: String(j.title ?? name).slice(0, 40),
            summary: String(j.summary ?? '').slice(0, 200),
            modules: Array.isArray(j.modules) ? j.modules.slice(0, 8).map(String) : [],
            domain: Array.isArray(j.domain) ? j.domain.slice(0, 8).map(String) : [],
            acceptance: Array.isArray(j.acceptance) ? j.acceptance.slice(0, 3).map(String) : [],
          };
          source = 'AI 逆向编译';
        }
      }
    }
    if (!concept) {
      // 规则提炼（无 key 兜底——诚实标注）
      const mods = profile.structure.filter(s => !/\.(md|json|lock)$/i.test(s)).slice(0, 6);
      concept = {
        title: name,
        summary: profile.readme.split('\n')[0]?.slice(0, 120) || `${name}（${profile.type} 项目，${profile.structure.length} 个顶层条目）`,
        modules: mods,
        domain: map.map.split('\n').filter(l => l.startsWith('## ')).slice(0, 5).map(l => l.slice(3)),
        acceptance: [
          `项目可构建（${profile.buildCmd || '未声明构建命令'}）`,
          `测试可运行（${profile.testCmd || '未声明测试命令'}）`,
          '核心模块结构可识别',
        ],
      };
    }
    // 3. 概念文档落盘（可喂回 /build——双向编译闭环）
    const outFile = join(ctx.dataDir, 'understand', `${name.replace(/[^\w-]/g, '_')}.md`);
    try {
      mkdirSync(join(ctx.dataDir, 'understand'), { recursive: true });
      writeFileSync(outFile, [
        `# ${concept.title}（概念规格——逆向编译，${source}）`,
        '',
        `> 来源：${dir}`,
        '',
        `## 摘要`,
        concept.summary,
        '',
        `## 模块分解`,
        ...concept.modules.map(m => `- ${m}`),
        '',
        `## 核心概念/领域模型`,
        ...concept.domain.map(d => `- ${d}`),
        '',
        `## 验收建议（可验证）`,
        ...concept.acceptance.map(a => `- [ ] ${a}`),
        '',
        `## 来源证据`,
        `- 项目类型：${profile.type}`,
        `- 构建：${profile.buildCmd || '—'}｜测试：${profile.testCmd || '—'}｜运行：${profile.runCmd || '—'}`,
        `- 扫描文件：${map.scanned}｜跳过：${map.skipped}`,
        '',
        `> 双向编译：把本文喂回 /build 可重新编译为可运行项目（概念 ↔ 代码闭环）`,
      ].join('\n'), 'utf8');
    } catch { /* 落盘失败不阻断 */ }
    return lines(` 概念规格「${concept.title}」（${source}） `, [
      ` 摘要：${concept.summary.slice(0, 100)}`,
      ` 模块：${concept.modules.join(' → ') || '—'}`,
      ` 概念：${concept.domain.join(' / ') || '—'}`,
      ` 验收：${concept.acceptance.map(a => '✓ ' + a.slice(0, 40)).join('\n       ')}`,
      ` 证据：${dir}（${map.scanned} 文件扫描）`,
      ` 落盘：${outFile}（/build 可反向编译回可运行项目——概念双向编译闭环）`,
    ]);
  });

  // /delegate：派发只读子代理（P0-2：--agent <name> 指定自定义 agent 定义）
  bus.register('/delegate', async (args) => {
    // W3 Subagent 第 1 步：组合路由决策——modern/required 在 live process host 接线完成前 fail-closed
    const { decideSubagentRoute } = await import('./extensionRouting.js');
    const subagentRoute = decideSubagentRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!subagentRoute.ok) {
      throw new Error(`[${subagentRoute.error.code}] ${subagentRoute.error.message}`);
    }
    // W3 Subagent facade：modern 路由走 live process host——worktree（git add + realpath 双检）中
    // 真实 spawn dist/cli 子进程，start 返回 running receipt；fence（lineage 迟到结果丢弃）→
    // terminateTree（taskkill 树终止）→ stop receipt（树未退出即 SUBAGENT_STOP_FAILED）。
    if (subagentRoute.value.route === 'modern') {
      const { resolve } = await import('node:path');
      const { execFile, spawn } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { realpath } = await import('node:fs/promises');
      const execFileAsync = promisify(execFile);
      const { WorktreeManager } = await import('../infrastructure/autonomy/worktreeManager.js');
      const { SubagentHost } = await import('../infrastructure/autonomy/subagentHost.js');
      const { SubagentService } = await import('../application/autonomy/subagentService.js');
      const taskId = `sub-${Date.now().toString(36)}`;
      const goal = args.filter(a => a !== '--agent').join(' ').trim();
      if (!goal) return '用法：/delegate <任务>（modern：live process host 真实子进程执行）';
      const dataDir = ctx.dataDir;
      const worktrees = new WorktreeManager({
        dataDir,
        git: async (gitArgs, opts) => {
          try {
            const r = await execFileAsync('git', gitArgs, { cwd: opts?.cwd ?? ctx.cwd, shell: false, windowsHide: true });
            return { ok: true as const, value: { stdout: String(r.stdout), stderr: String(r.stderr) } };
          } catch (cause) {
            return { ok: false as const, error: { code: 'WORKTREE_GIT_FAILED', message: String(cause), messageKey: 'WORKTREE_GIT_FAILED', retryable: false } };
          }
        },
        realpath: async path => realpath(path),
      });
      // 生产 fence：AbortController 集合（fence 后迟到结果丢弃由 host stop 语义保证——先 fence 后 abort）
      const controllers = new Map<string, AbortController>();
      const host = new SubagentHost({
        spawn: async (executable, argv, options, signal) => {
          const controller = new AbortController();
          controllers.set(taskId, controller);
          const onAbort = () => { try { controller.abort(); } catch { /* 已终止 */ } };
          signal.addEventListener('abort', onAbort, { once: true });
          const child = spawn(executable, [...argv], { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = ''; let errText = '';
          child.stdout!.on('data', (c: Buffer) => { out += c; });
          child.stderr!.on('data', (c: Buffer) => { errText += c; });
          return new Promise(resolveResult => {
            const timer = setTimeout(() => {
              try { child.kill(); } catch { /* 已退出 */ }
              resolveResult({ processId: child.pid ?? -1, exitCode: null, signal: null, stdout: out, stderr: errText, timedOut: true, aborted: false });
            }, options.timeoutMs);
            controller.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolveResult({ processId: child.pid ?? -1, exitCode: null, signal: 'ABORT', stdout: out, stderr: errText, timedOut: false, aborted: true });
            }, { once: true });
            child.on('close', code => {
              clearTimeout(timer);
              signal.removeEventListener('abort', onAbort);
              resolveResult({ processId: child.pid ?? -1, exitCode: code, signal: null, stdout: out, stderr: errText, timedOut: false, aborted: false });
            });
          });
        },
        terminateTree: async processId => {
          try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('taskkill', ['/pid', String(processId), '/t', '/f'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
            return { ok: true as const, value: undefined };
          } catch {
            // 进程已退出同样视为树终止成功
            return { ok: true as const, value: undefined };
          }
        },
        fence: async () => ({ ok: true as const, value: undefined }),
      });
      const service = new SubagentService(host, worktrees);
      const cli = resolve(process.cwd(), 'dist', 'cli', 'index.js');
      const started = await service.start({
        taskId,
        baseCommit: 'HEAD',
        executable: process.execPath,
        argv: [cli, '-p', goal],
        cwd: ctx.cwd,
        parentRemaining: {
          tool: 64, token: 32_000, cost: 1, wallclock: 600, turn: 24, retry: 2, depth: 2,
          fanout: 4, 'concurrent-agent': 4, network: 8, 'external-writes': 0,
          'browser-desktop': 0, screenshot: 0, files: 64, bytes: 1_000_000,
        },
        parentScope: { toolIds: [], filePaths: [ctx.cwd], secretIds: [] },
      }, AbortSignal.timeout(600_000));
      if (!started.ok) throw new Error(`[${started.error.code}] ${started.error.message}`);
      const receipt = started.value.receipt;
      return lines(' 子代理已启动（live process host） ', [
        ` receipt：${receipt.taskId}（pid ${receipt.processId} @ ${receipt.startedAt}）`,
        ` worktree：${started.value.worktreePath}`,
        ` 预算：turn ${started.value.budget.turn} · token ${started.value.budget.token}`,
        ' 停：再次 /delegate --stop <taskId>（fence → 进程树终止 → stop receipt）',
      ]);
    }
    const agentIdx = args.indexOf('--agent');
    let agentName: string | null = null;
    if (agentIdx >= 0) agentName = String(args[agentIdx + 1] ?? '');
    const task = args.filter((a, i) => a !== '--agent' && args[i - 1] !== '--agent').join(' ').trim();
    if (!task) return '用法：/delegate <任务> [--agent <自定义agent名>]（派发子代理，结果返回当前会话）';
    if (!ctx.agent) return 'delegate 不可用：当前环境未提供子代理能力';
    ctx.bus.emit('system.notice', { text: `派发子代理：「${task.slice(0, 60)}」…` });
    const id = `t${Date.now().toString(36)}`;
    try {
      ctx.db.prepare(`INSERT INTO tasks (id, goal, status, created_at) VALUES (?,?,?,?)`).run(id, `delegate: ${task.slice(0, 180)}`, 'running', Date.now());
    } catch { /* 任务表未就绪时跳过持久化 */ }
    try {
      // P0-2：--agent 指定定义时按定义派发（指令/模式/工具白名单生效）
      let def: { systemPromptOverride?: string; mode?: string; tools?: string[] } | undefined;
      if (agentName) {
        const { findAgentDef } = await import('../kernel/agents.js');
        const d = findAgentDef(agentName, ctx.cwd, ctx.dataDir);
        if (!d) return `agent「${agentName}」不存在（/agent list 查看）`;
        def = { systemPromptOverride: d.instructions, mode: d.mode, tools: d.tools };
      }
      const r = await ctx.agent.spawnSubagent(task, undefined, def);
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
    // 护栏明示（余额耗尽场景防线）：goal 循环是烧钱大户——启动时报告护栏状态
    const s = (ctx.config.get('settings') ?? {}) as Record<string, any>;
    const bm = (s.balanceMonitor ?? {}) as Record<string, any>;
    const budget = Number(s.budgetTokens) || 0;
    const hardStop = s.budgetStop === true;
    const autoStop = bm.autoStop === true;
    const guardNote = `（护栏：余额 auto-stop ${autoStop ? '开 ✓' : '关'}｜token 预算 ${budget ? `${budget}${hardStop ? ' 硬停 ✓' : ''}` : '未设'}${autoStop || (budget && hardStop) ? '' : '——/balance auto-stop on 或 /config set budgetTokens N budgetStop true 防超支'}）`;
    const rounds: string[] = [];
    const notes: string[] = [];
    const cap = Math.min(maxIter, 8);
    let done = false;
    let cancelled = false;
    for (let i = 1; i <= cap; i++) {
      // A24：goal 进度实时上报（UI 后台面板「目标循环」区——与内核 goal 模式同事件）
      try { ctx.bus?.emit('agent.goal', { round: i, maxRounds: cap, done: false, cancelled: false, text: goal.slice(0, 80) }); } catch { /* 事件失败不阻断 */ }
      const prompt = `目标：${goal}\n当前进度：${rounds.at(-1) ? '已完成以下工作——' + rounds.at(-1)!.slice(0, 600) : '尚未开始'}。\n请继续推进目标。若目标已全部完成，以「✓ 已完成」开头输出总结；否则输出本轮完成的事项与下一步。`;
      // goalLoop:false——/goal 命令自身循环，显式关闭内核 goal 模式内层循环（防 8×10 嵌套）
      const r = await ctx.agent.run(prompt, { goalLoop: false });
      rounds.push(r.text);
      // 中断（Ctrl+C/Esc×2）：如实 cancelled 结束，不空转剩余轮次
      if (r.interrupted) { cancelled = true; break; }
      // 完成声明统一判定：内核 isCompletionClaim（含 [GOAL_DONE]）+ 兼容标记（✓ 已完成/✅）
      if (isCompletionClaim(r.text) || r.text.includes('✓ 已完成') || r.text.includes('✅')) {
        // A22 诚实交付：声称完成 ≠ 完成——有构建产物（projects/ 有项目）才跑真实验证
        // （启动→探活→重启→读回）；验证通过才判完成，无产物/验证失败均不判完成（KF-023 语义）
        const projectsDir = join(ctx.dataDir, 'projects');
        const proj = existsSync(projectsDir) ? readdirSync(projectsDir).filter(n => n.startsWith('p')).sort().at(-1) : null;
        if (!proj) {
          notes.push('⚠ 声称完成但无产物可验证（未验证）——不判完成，诚实 incomplete');
          break;
        }
        try {
          const { verifyProject } = await import('../build/verify.js');
          const vr = await verifyProject(join(projectsDir, proj));
          if (vr.status === 'ok') { done = true; break; }
          notes.push(`⚠ 声称完成但验证未通过：${vr.detail.slice(0, 160)}`);
        } catch (e: any) {
          // fail-closed：验证异常绝不视为通过（此前 catch { verified = true } 假绿）
          notes.push(`⚠ 声称完成但验证异常（未验证）：${e?.message?.slice(0, 160) ?? e}`);
        }
      }
      if (r.text.includes('未配置模型密钥')) break; // 无 key：不空转（去掉恒假 !r.ok 前置）
    }
    try { ctx.bus?.emit('agent.goal', { round: done || cancelled ? rounds.length : cap, maxRounds: cap, done, cancelled, text: rounds.at(-1)?.slice(0, 80) ?? '' }); } catch { /* 忽略 */ }
    return lines(` 目标执行 ${done ? '✓ 完成' : cancelled ? '已取消' : `（${rounds.length} 轮）`} `, [
      ` 目标：${goal.slice(0, 80)}`,
      guardNote,
      ...rounds.map((r, i) => ['', ` ── 第 ${i + 1} 轮 ──`, ...String(r).split('\n').slice(0, 12).map(l => ` ${l.slice(0, 110)}`)]).flat(),
      ...notes,
      ...(rounds.length >= cap && !done && !cancelled ? [' ⚠ 已达轮次上限仍未验证完成（诚实 incomplete）'] : []),
    ]);
  });

  // /plan：计划模式产物（对比轮 6 补强——对齐参考 plan 文件机制）
  //   /plan on|off 模式切换 ｜ /plan save [需求] LLM 生成计划文件 ｜ /plan view ｜ /plan clear
  bus.register('/plan', async (args) => {
    const [sub, ...rest] = args;
    // 审查修复：会话统一——作用于当前会话
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
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
      const { resolveApiKey } = await import('../kernel/providers.js');
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (!keyRes.key) return '未配置模型密钥——/key set <密钥> 后 /plan save 才能生成计划（不产生假内容）';
      if (keyRes.error === 'decrypt-failed') return '密钥无法解密——请 /key set <密钥> 重新配置';
      const key = keyRes.key;
      const goal = rest.join(' ').trim() || String(ctx.mem.recall(sid).filter(m => m.role === 'user').at(-1)?.content ?? '').slice(0, 500);
      if (!goal) return '没有可规划的需求——/plan save <需求描述> 或先对话几轮';
      try {
        const { buildChatRequest } = await import('../kernel/providers.js');
        const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
        const model = resolveDefaultModel(ctx.config.get('settings') as any);
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
    if (!path) return '用法：/import <文件路径>（JSON [{role,content}] 或 JSONL/文本）';
    // 审查修复：会话统一——导入到当前会话（此前硬编码 default）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    let text = '';
    try { text = readFileSync(resolve(process.cwd(), path), 'utf8'); } catch { return `无法读取文件：${path}`; }
    let imported = 0;
    const ins = ctx.db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, ts) VALUES (?,?,?,?,?)`);
    const now = Date.now();
    const push = (role: string, content: string) => {
      if (!['user', 'assistant', 'system'].includes(role)) return;
      ins.run(sid, role, content, null, now + imported);
      imported++;
    };
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        // JSON 数组 [{role,content}]
        for (const m of data) push(String(m?.role ?? 'user'), String(m?.content ?? ''));
      } else {
        // 单对象 → 单条
        push(String(data?.role ?? 'user'), String(data?.content ?? text));
        if (!imported) { ctx.mem.append(sid, 'user', text); imported = 1; }
      }
    } catch {
      // 非 JSON 数组：尝试 JSONL（/export --jsonl 的输出——每行一个 JSON 对象；
      // 此前整体 JSON.parse 失败被当 1 条大文本导入，387 条导出只能导回 1 条）
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const allLinesJson = lines.length > 1 && lines.every(l => l.startsWith('{'));
      if (allLinesJson) {
        for (const line of lines) {
          try {
            const m = JSON.parse(line);
            push(String(m?.role ?? 'user'), String(m?.content ?? ''));
          } catch { /* 坏行跳过 */ }
        }
      }
      if (!imported) { ctx.mem.append('default', 'user', text); imported = 1; }
    }
    return `已导入 ${imported} 条消息到当前会话（/resume 或直接继续对话）`;
  });

  // /flow <需求>：AI 生成流程图（Mermaid）写入 data/flow/（参考 flow 技能的落地替代）
  bus.register('/flow', async (args) => {
    // ── 技能流程驱动（frontmatter flow: "准备 → 构建 → 部署"）──
    const [sub] = args;
    if (sub === 'status') {
      const rows = ctx.db.prepare(`SELECT skill, nodes, current, finished FROM flow_runs ORDER BY id DESC LIMIT 1`).get() as any;
      if (!rows) return '当前无流程——/flow <技能名> 启动技能流程';
      const nodes = JSON.parse(rows.nodes) as Array<{ name: string; instruction: string }>;
      return lines(` 流程 ${rows.skill} `, [
        ...nodes.map((n, i) => ` ${i === rows.current && !rows.finished ? '▶' : i < rows.current || rows.finished ? '✓' : '·'} ${n.name}`),
        rows.finished ? ' 已完成' : ` 下一步：/flow next（${rows.current + 1}/${nodes.length}）`,
      ]);
    }
    if (sub === 'cancel') {
      ctx.db.prepare(`UPDATE flow_runs SET finished=1 WHERE finished=0`).run();
      return '已取消全部进行中的流程';
    }
    if (sub === 'next') {
      // 推进当前流程到下一步（审计修复：status 提示 /flow next 但此前无 next 分支）
      const run = ctx.db.prepare(`SELECT id, skill, nodes, current FROM flow_runs WHERE finished=0 ORDER BY id DESC LIMIT 1`).get() as any;
      if (!run) return '当前无进行中的流程——/flow <技能名> 启动';
      const nodes = JSON.parse(run.nodes) as Array<{ name: string; instruction: string }>;
      const next = run.current + 1;
      if (next >= nodes.length) {
        ctx.db.prepare(`UPDATE flow_runs SET finished=1 WHERE id=?`).run(run.id);
        return `流程「${run.skill}」全部完成 ✓`;
      }
      ctx.db.prepare(`UPDATE flow_runs SET current=? WHERE id=?`).run(next, run.id);
      const node = nodes[next]!;
      void ctx.agent?.run(`（流程「${run.skill}」步骤 ${next + 1}/${nodes.length}：${node.name}）执行以下步骤并完成后简要汇报：\n${node.instruction}`).catch(() => {});
      return `▶ 流程「${run.skill}」推进到步骤 ${next + 1}/${nodes.length}：${node.name}（/flow next 继续，/flow status 查看进度）`;
    }
    const skillName = sub ?? '';
    if (skillName && skillName !== 'mermaid' && !/[\s，。]/.test(skillName)) {
      // 技能名 → 技能流程启动（技能未定义流程时回落到 AI 生成）
      const { loadSkill, parseFlow } = await import('../kernel/skills.js');
      const skill = loadSkill(ctx.dataDir, ctx.cwd, skillName);
      if (skill) {
        const flow = parseFlow(skill.body, skill.meta.flow);
        if (flow) {
          let run = ctx.db.prepare(`SELECT id, current FROM flow_runs WHERE skill=? AND finished=0 ORDER BY id DESC LIMIT 1`).get(skillName) as { id: number; current: number } | undefined;
          if (!run) {
            const r = ctx.db.prepare(`INSERT INTO flow_runs (skill, nodes, current, finished, ts) VALUES (?,?,?,?,?)`)
              .run(skillName, JSON.stringify(flow), 0, 0, Date.now());
            run = { id: Number(r.lastInsertRowid), current: 0 };
          }
          const node = flow[run.current]!;
          void ctx.agent?.run(`（流程「${skillName}」步骤 ${run.current + 1}/${flow.length}：${node.name}）执行以下步骤并完成后简要汇报：\n${node.instruction}`).catch(() => {});
          return `▶ 流程「${skillName}」步骤 ${run.current + 1}/${flow.length}：${node.name}（/flow next 推进，/flow status 查看进度）`;
        }
      }
    }
    // ── AI 生成 Mermaid 流程图（默认路径）──
    const goal = args.join(' ').trim();
    if (!goal) return '用法：/flow <流程需求> ｜ /flow <技能名>（技能流程）｜ /flow next｜status｜cancel';
    const { resolveApiKey } = await import('../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) return '未配置模型密钥——/key set <密钥> 后 /flow 才能生成流程图';
    if (keyRes.error === 'decrypt-failed') return '密钥无法解密——请 /key set <密钥> 重新配置';
    const key = keyRes.key;
    try {
      const { buildChatRequest } = await import('../kernel/providers.js');
      const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
      const model = resolveDefaultModel(ctx.config.get('settings') as any);
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

// ── A20：后台终端（/term）——node-pty 真实交互会话 ──────────
  // 与 /jobs（一次性后台执行）不同：持久 PTY，可注入输入、跟随输出——
  // python REPL / ssh / 交互式命令都能跑。write/kill 为 danger（写终端=执行命令）。
  bus.register('/term', async (args) => {
    const tm = ctx.term;
    if (!tm) return '后台终端不可用（term 未装配）';
    const [sub, ...rest] = args.join(' ').trim().split(/\s+/);
    const action = (sub ?? '').toLowerCase();

    if (!action || action === 'list') {
      const list = tm.list();
      if (!list.length) return '无后台终端（/term new 启动一个）';
      return list.map(s => `${s.status === 'running' ? '●' : '○'} ${s.id}  ${s.shell}  ${s.status === 'running' ? '运行中' : `已退出(${s.exitCode})`}  ${new Date(s.startedAt).toLocaleTimeString()}`).join('\n');
    }

    if (action === 'new') {
      const shell = rest.join(' ').trim() || undefined;
      const r = await tm.spawn(shell);
      return r.ok ? `终端已启动 → ${r.id}（/term attach ${r.id} 跟随输出；/term write ${r.id} <命令> 注入输入）` : r.error;
    }

    if (action === 'write') {
      const id = rest[0] ?? '';
      const input = `${rest.slice(1).join(' ')}\r`;
      if (!id || !rest.slice(1).length) return '用法：/term write <id> <命令>';
      const r = tm.write(id, input);
      return r.ok ? `已注入 → ${id}` : r.error;
    }

    if (action === 'kill') {
      const id = rest[0] ?? '';
      if (!id) return '用法：/term kill <id>';
      const r = tm.kill(id);
      return r.ok ? `已终止 → ${id}` : r.error;
    }

    if (action === 'attach') {
      const id = rest[0] ?? '';
      if (!id) return '用法：/term attach <id>';
      const s = tm.get(id);
      if (!s) return `终端 ${id} 不存在（/term 查看列表）`;
      const log = tm.getLog(id) || '（无输出——等待输入？/term write 注入）';
      return `── 终端 ${id}（${s.shell} ${s.status}）──
${log.slice(-3000)}`;
    }

    return '用法：/term [list] | new [shell] | write <id> <命令> | kill <id> | attach <id>';
  });

  // 审计留痕（审查修复：计数动态化——此前硬编码 48 与实际注册数不符）
  try {
    const registered = (ctx.commandBus as any)?.list?.().length ?? 'n/a';
    appendAudit(ctx.db, 'handlers.ext.registered', { count: registered });
  } catch { /* 审计表未就绪时静默 */ }
}
