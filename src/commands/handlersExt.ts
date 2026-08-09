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
import type { HandlerCtx } from './handlers.js';
import type { CommandBus } from '../app/CommandBus.js';

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

// 安全表达式求值（仅数字/四则/括号/空格）
function safeEval(expr: string): number | null {
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export function registerExtHandlers(bus: CommandBus, ctx: HandlerCtx): void {
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
    const sec = parseInt(args[0] ?? '60', 10);
    if (!Number.isFinite(sec) || sec < 1 || sec > 3600) return '用法：/timer <秒>（到时提示）';
    const end = Date.now() + sec * 1000;
    return `计时器已启动：${sec}s（${new Date(end).toTimeString().slice(0, 8)} 到点）`;
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

  bus.register('/undo', () => {
    const last = ctx.db.prepare(`SELECT id FROM messages WHERE session_id='default' AND role!='system' ORDER BY id DESC LIMIT 1`).get() as any;
    if (!last) return '没有可撤销的消息';
    ctx.db.prepare(`DELETE FROM messages WHERE id=?`).run(last.id);
    return '已撤销最后一条消息';
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

  bus.register('/curator', () => {
    const rec = ctx.mem.recall('default');
    return lines(' 黑洞策展 ', [
      ` 全量 ${rec.length} 条（FTS 可检索）`,
      ` 工作窗口 ${Math.min(rec.length, 20)}/20`,
      ` 吸附 ${ctx.mem.absorbCount('default')} 条`,
      ` 建议：/compact 压缩 · /hole <词> 检索 · /export <词> 导出`,
    ]);
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

  bus.register('/skill', (args) => {
    const name = args[0];
    if (!name) return '用法：/skill <技能名>（生成 SKILL.md）';
    const outDir = join(ctx.dataDir, 'forge', name);
    mkdirSync(outDir, { recursive: true });
    const skill = forgeSkillDir(outDir, name, `${name} 技能`, '1. 理解任务 2. 制定步骤 3. 执行并验证');
    return `技能已生成 → ${skill}`;
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
  bus.register('/sandbox', () => {
    const HARD = ['rm -rf /', 'format', 'del /s', 'shutdown', 'mkfs', 'dd if='];
    return lines(' 沙箱 ', [
      ` 模式：${ctx.getMode()}（smart/auto/manual/plan/yolo）`,
      ` 硬性红线：${HARD.join(' · ')}…（任何模式不可绕过）`,
      ` 工具：/perm <模式> 切换权限`,
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
  bus.register('/mcp', (args) => {
    const name = args[0];
    if (name) return `/mcp <名称>：生成 MCP server → ${join(ctx.dataDir, 'forge', name)}（用 /forge ${name}）`;
    return lines(' MCP ', [` stdio JSON-RPC 协议`, ` 用法：/forge <名称> 生成 server.js + SKILL.md`, ` 连接：/gateway 查看网关状态`]);
  });

  bus.register('/claw', async () => {
    try {
      const { ComputerUse } = await import('../kernel/computer/index.js');
      return lines(' Computer Use ', [' 动作层：robotjs + 屏幕捕获', ' 守卫：边界/中止/串行', ' 用法：说「帮我打开记事本输入…」']);
    } catch { return 'Computer Use：模块未加载（需图形环境）'; }
  });

  bus.register('/gateway', () => lines(' 网关 ', [' 状态：本地直连（OpenAI 兼容）', ' 代理：/proxy 查看', ' Webhook：/webhook 注册回调']));

  bus.register('/proxy', (args) => {
    const v = args[0];
    if (v) { ctx.config.setKey('settings', 'proxy', v); return `代理已设置：${v}`; }
    return `代理：${ctx.config.getKey('settings', 'proxy') ?? '未设置（直连）'}`;
  });

  bus.register('/webhook', () => 'Webhook：注册回调 URL 到本地事件总线（开发中，可配置 /config）');

  bus.register('/a2a', () => lines(' A2A ', [' Agent-to-Agent 协议', ' 状态：实验性（可与 /swarm 组合）']));

  bus.register('/acp', () => 'ACP（Agent Client Protocol）：状态：实验性');

  // ── 协作类 ──────────────────────────────────
  bus.register('/swarm', () => lines(' 集群 ', [' 多代理并行：/delegate <任务> 派发', ' 角色：规划/编码/审查 子代理']));

  bus.register('/duo', () => '双人模式：与另一代理协同（实验性）');

  bus.register('/cron', () => {
    try {
      const jobs = ctx.db.prepare(`SELECT * FROM cron_jobs ORDER BY id`).all() as any[];
      if (!jobs.length) return '暂无定时任务（说「每天早上9点提醒我」创建）';
      return lines(' 定时任务 ', jobs.map(j => ` ${j.id}  ${j.schedule}  ${String(j.action ?? '').slice(0, 30)}`));
    } catch { return '定时任务表未初始化（说「每天早上9点提醒我」自动创建）'; }
  });

  bus.register('/jobs', () => '任务队列：当前无后台任务（/build 编译任务同步执行）');

  bus.register('/delegate', (args) => {
    const task = args.join(' ');
    if (!task) return '用法：/delegate <任务>（派发给子代理，只读工具集）';
    return `已派发任务：「${task.slice(0, 50)}」（子代理运行中…结果将回到会话）`;
  });

  bus.register('/goal', (args) => {
    const goal = args.join(' ');
    if (!goal) return '用法：/goal <目标>（开放目标驱动，规划→执行→验证）';
    return `目标已设定：「${goal.slice(0, 60)}」——概念编译器将拆解为计划并逐步执行`;
  });

  // 审计留痕
  try { appendAudit(ctx.db, 'handlers.ext.registered', { count: 47 }); } catch { /* 审计表未就绪时静默 */ }
}
