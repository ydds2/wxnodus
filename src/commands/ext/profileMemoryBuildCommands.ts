// src/commands/ext/profileMemoryBuildCommands.ts — 档案/余额/记忆/构建/安全/系统类命令（handlersExt 巨文件拆分第 3 块，audit §13.46）
// /profile /balance /config /warp /fortune /context /compact /digest /curator /deploy /forge /skill /learn /assimilate /gate /fdr /evidence /sandbox /compliance /consent /audit /encrypt /lang /logs /bench
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { appendAudit, restoreCheckpoint } from '../../store/db.js';
import { parseSinceArg } from '../../kernel/memory.js';
import { estimateTokens } from '../../kernel/memory.js';
import { settingsLayers } from '../../kernel/projectConfig.js';
import { runGate } from '../../build/gate.js';
import { writeEvidence } from '../../build/evidence.js';
import { forgeMcpServer, forgeSkillDir } from '../../forge/forge.js';
import { discoverSkills, loadSkill, writeSkill, skillContentForModel } from '../../kernel/skills.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../../kernel/defaults.js';
import { HARD_REDLINES } from '../../kernel/permissions.js';
import { unknownSettingsKeys, knownSettingsKeys } from '../../store/config.js';
import { runCuratorReview, curatorConfigFrom, readCuratorState } from '../../kernel/curator.js';
import { sessionCost, costText } from '../../kernel/costQuery.js';
import { encryptKey } from '../../kernel/providers.js';
import { resolveProviderProfile } from '../../kernel/profiles.js';
import { fetchBalanceCached } from '../../kernel/balance.js';
import { c, type HandlerCtx } from '../handlers.js';
import { commandCompletion, type CommandBus, type StructuredCommand } from '../../app/CommandBus.js';

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

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

export function registerProfileMemoryBuildCommands(bus: CommandBus, ctx: HandlerCtx): void {
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
      return `档案已创建并激活：${id}（${parsed.baseURL}）\n下一步：/model set-key <密钥>（写入当前档案）→ /model <模型名>`;
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
        const { ConsentLedger } = await import('../../compliance/compliance.js');
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
      if (!rp) return '未配置档案（/profile add 或 /model set-key 后重试）';
      const profile = { ...rp.profile, balanceUrl: bm.url || rp.profile.balanceUrl || '', balancePath: bm.jsonPath || rp.profile.balancePath || '' };
      const r = await fetchBalanceCached(profile, (ctx.config.get('settings') ?? {}) as Record<string, any>, { force: sub === 'refresh', db: ctx.db });
      if (r.ok) {
        const { numericBalance, LOW_BALANCE_THRESHOLD } = await import('../../kernel/balance.js');
        const threshold = Number((bm as any).lowThreshold ?? LOW_BALANCE_THRESHOLD);
        const num = numericBalance(r.info);
        const low = num !== null && num < threshold ? `\n⚠ 余额不足预警：当前 ${r.info.balance}（阈值 ${threshold}——低于阈值请及时充值）` : '';
        return `余额：${r.info.balance}${r.info.currency ? ` ${r.info.currency}` : ''}（${r.info.source}${r.cached ? '，缓存中' : ''}）${low}`;
      }
      return commandCompletion(`余额获取失败：${r.error}`, 'blocked', r.error);
    }
    return '用法：/balance set [url] [--path <jsonPath>] | on | off | threshold <数值> | auto-stop [on|off] | status | refresh';
  });

  // ── 彩蛋（趣味拉满：纯文本无副作用）──
  // /fortune 已在 registerCoreHandlers 注册（单一事实源）——此处不再重复注册（重复注册后被覆盖的死实现，2026-08-19 审计去重）
  bus.register('/warp', () => ['✦ 曲率引擎预热', '✦ ✦ 折叠空间', '✦ ✦ ✦ 穿越虫洞', '· ✦ · 已到达目标星系 ✦'].join('\n'));

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
        const { resolveApiKey } = await import('../../kernel/providers.js');
        const keyRes = resolveApiKey(ctx.config.get('settings') as any);
        if (!keyRes.key) return `（规则压缩）${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
        const { callModelOnce } = await import('../../kernel/llmOnce.js');
        const { COMPRESSOR_SYSTEM_PROMPT } = await import('../../kernel/memory.js');
        const baseURL = resolveDefaultBaseURL(ctx.config.get('settings') as any);
        const model = resolveDefaultModel(ctx.config.get('settings') as any);
        // 独立单轮请求（全新 [system,user] 对）——结果只写回记忆库，不污染主对话前缀缓存
        const r = await callModelOnce({
          baseURL, model, key: keyRes.key,
          messages: [
            { role: 'system', content: COMPRESSOR_SYSTEM_PROMPT },
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
      const { resolveApiKey } = await import('../../kernel/providers.js');
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (keyRes.key) {
        const key = keyRes.key;
        const { buildChatRequest } = await import('../../kernel/providers.js');
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
    const report = runCuratorReview(ctx.mem, ctx.dataDir, ctx.cwd, ctx.agent?.getSessionId?.() ?? 'default');
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
    if (!projects.length) return '暂无编译项目（说「做个待办系统」触发 /build）';
    const target = args[0];
    if (!target) {
      return lines(' 项目（/deploy <名称> 部署） ', projects.map(p => ` ${p}`));
    }
    if (!projects.includes(target)) return `项目不存在：${target}（/deploy 查看列表）`;
    const projDir = join(dir, target);
    // 1. 验证完整性（真实探活：启动→探活→重启→读回）
    const { verifyProject } = await import('../../build/verify.js');
    const vr = await verifyProject(projDir);
    if (vr.status !== 'ok') return `部署前置验证失败：${vr.detail}——修复后重试`;
    // 2. 后台启动（独立进程，不阻塞 CLI；端口 4321 与验证一致）
    const entry = join(projDir, 'server', 'index.js');
    const { spawn } = await import('node:child_process');
    const { sanitizedEnv } = await import('../../kernel/env.js');
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
      const { createRegistry } = await import('../../forge/registry.js');
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
    const { resolveApiKey } = await import('../../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) return '当前未配置模型密钥——/model set-key <密钥> 后 /learn 才能用 AI 总结生成技能（不产生假内容）';
    if (keyRes.error === 'decrypt-failed') return '密钥无法解密（机器环境变化或数据损坏？）——请用 /model set-key <密钥> 重新配置。';
    const key = keyRes.key;
    const recent = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').slice(-8);
    if (!recent.length) return '暂无对话记忆可学习——先对话几轮再 /learn';
    const desc = args.slice(1).join(' ') || `${name} 技能`;
    const transcript = recent.map(r => `${r.role}: ${String(r.content ?? '').slice(0, 300)}`).join('\n');
    const { buildChatRequest } = await import('../../kernel/providers.js');
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
      const { scanCodeTargets } = await import('../../infrastructure/code/codeIndexer.js');
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

    const { assimilateDir, assimilateMaterial, readMaterial } = await import('../../kernel/assimilate.js');
    // LLM 消化回调（无 key 前置拦截——不产生假内容；与 /learn 同款调用模式）
    const makeDigest = (key: string) => async (prompt: string): Promise<string> => {
      const { buildChatRequest } = await import('../../kernel/providers.js');
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
    const { resolveApiKey } = await import('../../kernel/providers.js');
    const requireKey = () => {
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (!keyRes.key) return { error: '消化需要模型密钥——/model set-key <密钥> 后可用（无 key 不产生假内容）' };
      if (keyRes.error === 'decrypt-failed') return { error: '密钥无法解密（机器环境变化或数据损坏？）——请 /model set-key <密钥> 重新配置' };
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
    const { resolveApiKey } = await import('../../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) {
      // 无 key：生成待补全模板但明确标注未审查（不假装已审查）
      const doc = `# FDR — ${name}\n\n> ⚠ 未配置模型密钥——本模板未经过 AI 审查（/model set-key 后 /fdr 重跑生成真实审查）\n\n## 需求\n\n## 设计\n\n## 实现\n\n## 验证\n`;
      writeFileSync(out, doc, 'utf8');
      return `FDR 模板已生成 → ${out}（未配置密钥，未审查——/model set-key 后重跑）`;
    }
    // 有 key：模型真实审查最近对话（需求/设计/实现/验证四段）
    const recent = ctx.mem.recall(ctx.agent?.getSessionId?.() ?? 'default').slice(-12);
    if (!recent.length) return '暂无对话记忆可审查——先对话几轮再 /fdr';
    const transcript = recent.map(r => `${r.role}: ${String(r.content ?? '').slice(0, 300)}`).join('\n');
    const { buildChatRequest, mapHttpError } = await import('../../kernel/providers.js');
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
    const { verifyProject } = await import('../../build/verify.js');
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
  // /sandbox 双层语义（gap P0-4 落地，2026-08-18）：
  //   策略层 L0-L3 → 权限模式映射（plan/smart/auto/yolo——审批语义，非 OS 隔离）
  //   执行层 os L0-L3 → 真实 OS 内核沙盒（受限令牌 + Job Object + 断网限速，
  //   settings.sandbox.profile 持久化；bash 执行时接入——探测失败 fail-closed 拒绝执行
  //   （settings.sandbox.failOpen=true 显式降级，绝不静默裸跑））
  bus.register('/sandbox', async (args) => {
    const LAYERS: Record<string, string> = { L0: 'plan', L1: 'smart', L2: 'auto', L3: 'yolo' };
    const current = Object.entries(LAYERS).find(([, m]) => m === ctx.getMode())?.[0] ?? '?';
    const osProfile = ((ctx.config.getKey('settings', 'sandbox') as Record<string, any> | undefined | null) ?? {})?.profile ?? 'off';
    if (args[0] === 'os') {
      const sub = (args[1] ?? '').toUpperCase();
      if (sub === 'FAILOPEN') {
        const want = String(args[2] ?? '').toLowerCase() === 'on';
        const curSbx = ((ctx.config.getKey('settings', 'sandbox') as Record<string, any> | undefined | null) ?? {});
        ctx.config.setKey('settings', 'sandbox', { ...curSbx, failOpen: want });
        return `sandbox.failOpen=${want ? 'true' : 'false'}——${want ? '沙盒不可用时显式降级裸跑（每次执行标注未沙盒）' : '沙盒不可用即拒绝执行（fail-closed，默认）'}（/sandbox os failopen on|off 切换）`;
      }
      if (['L0', 'L1', 'L2', 'L3', 'OFF'].includes(sub)) {
        ctx.config.setKey('settings', 'sandbox', { profile: sub === 'OFF' ? 'off' : sub });
        if (sub === 'OFF') return 'OS 沙盒已关闭（settings.sandbox.profile=off）——bash 按普通方式执行（策略层审批链不变）';
        const { sandboxSpec } = await import('../../kernel/winSandbox.js');
        const spec = sandboxSpec(sub as 'L0' | 'L1' | 'L2' | 'L3');
        const caps = [spec.lowIl ? 'Low IL 只读' : '', 'Job 遏制', spec.netLimitBps === 1 ? '断网' : spec.netLimitBps ? '限速 10KB/s' : '无网络限制'].filter(Boolean);
        return `OS 沙盒已开启：${sub}（${caps.join(' + ')}）——bash 命令此后经沙盒执行（持久化，/sandbox os status 验证能力）`;
      }
      const { probeOsSandbox } = await import('../../kernel/osSandbox.js');
      const probe = await probeOsSandbox(ctx.dataDir, sub === 'PROBE');
      const desc: Record<string, string> = {
        L0: '只读 + 断网（Low IL + Job + 1B/s 限速——标准用户可用，实测校准）',
        L1: '可写 + 断网（Job 遏制 + 1B/s 限速）',
        L2: '可写 + 限速 10KB/s（Job 遏制）',
        L3: '仅 Job 遏制（KILL_ON_CLOSE 防孤儿）',
        off: '关闭（bash 普通方式执行）',
      };
      return lines(' OS 沙盒 ', [
        ` 当前 profile：${String(osProfile ?? 'off').toUpperCase()}（${desc[String(osProfile).toLowerCase()] ?? desc['off']}）`,
        ` 能力探测：${probe.ok ? `✅ ${probe.detail}` : `❌ ${probe.detail}`}`,
        '',
        ' 用法：/sandbox os L0|L1|L2|L3|off|failopen on|off（开启/关闭，settings 持久化）',
        '      /sandbox os status（读缓存探测）  /sandbox os probe（强制重探）',
        ' 诚实口径（fail-closed）：沙盒开启但探测/启动失败时 bash 拒绝执行绝不静默裸跑；',
        '   settings.sandbox.failOpen=true 为显式逃生门（降级执行且每次标注未沙盒）',
      ]);
    }
    const want = (args[0] ?? '').toUpperCase();
    if (want in LAYERS) {
      ctx.setMode(LAYERS[want]!);
      const desc: Record<string, string> = { plan: '只读探索 + 计划审批', smart: '只读放行，危险工具确认', auto: '自动编辑（文件写入免确认）', yolo: '除硬红线全部放行' };
      return `权限层已切换：L${want.slice(1)} → ${LAYERS[want]} 模式（${desc[LAYERS[want]!]}）——注：这是策略层；执行层 OS 沙盒用 /sandbox os L0-L3`;
    }
    return lines(' 沙盒（双层） ', [
      ` 策略层（权限模式）：当前 L${current.slice(1)}（${ctx.getMode()}）`,
      `   L0 → plan  只读探索 + 计划审批（写操作需确认）`,
      `   L1 → smart 更改前确认：只读放行，危险工具确认（默认）`,
      `   L2 → auto  自动编辑：文件写入免确认，命令按分级`,
      `   L3 → yolo  完全访问：除硬红线全部放行`,
      ` 执行层（OS 内核沙盒）：${String(osProfile ?? 'off').toUpperCase()}（/sandbox os 查看/切换）`,
      '',
      ` 硬红线（任何模式不可绕过）：${HARD_REDLINES.map(r => r.desc).join(' · ')}`,
      ` 用法：/sandbox L0|L1|L2|L3（策略层）   /sandbox os L0|L1|L2|L3|off|status|probe（执行层）`,
    ]);
  });

  // ── 远程执行（supremacy 2.2 ssh 通道 + S-04 完整版 exec-server，2026-08-18）──
  // settings.remote = "ssh://user@host[:port]"（阶段 1：远端未沙盒诚实标注）
  // settings.remoteServer = {host,port,token}（完整版：长驻 exec-server + 远端 OS 沙盒复用）
  let execServerHandle: { close(): Promise<void> } | null = null;
  bus.register('/remote', async (args) => {
    const cur = String((ctx.config.getKey('settings', 'remote') as string | null | undefined) ?? '').trim();
    const curSrv = (ctx.config.getKey('settings', 'remoteServer') as Record<string, any> | null | undefined) ?? null;
    if (!args[0]) {
      return lines(' 远程执行（ssh 通道 + exec-server） ', [
        ` 当前目标：${curSrv ? `exec-server ${curSrv.host}:${curSrv.port}` : cur || '未配置'}`,
        ' 用法：/remote ssh://user@host[:port]（ssh 通道，远端未沙盒）',
        '      /remote server [--port N] [--secret S] [--profile L3] [--host 0.0.0.0]（本机/远端机启动长驻 exec-server）',
        '      /remote connect <host:port> --secret <S>（接入 exec-server——token 由共享口令 HMAC 派生）',
        '      /remote run <命令>（优先 exec-server（远端可沙盒）；否则 ssh）',
        '      /remote off（清除全部）   /remote status',
        ' 安全面：exec-server 默认 127.0.0.1；Bearer=HMAC(secret)；远端可经 OS 沙盒 profile 执行',
      ]);
    }
    if (args[0] === 'server') {
      if (execServerHandle) return 'exec-server 已运行（先停止当前实例）';
      const { startExecServer } = await import('../../kernel/execServer.js');
      const portArg = args.indexOf('--port'); const port = portArg >= 0 ? Number(args[portArg + 1]) || 0 : 0;
      const secArg = args.indexOf('--secret'); const secret = secArg >= 0 ? String(args[secArg + 1] ?? '') : String(ctx.config.getKey('settings', 'remoteServerSecret') ?? '');
      const profArg = args.indexOf('--profile'); const profile = profArg >= 0 ? String(args[profArg + 1] ?? 'off') : 'off';
      const hostArg = args.indexOf('--host'); const host = hostArg >= 0 ? String(args[hostArg + 1] ?? '') : '127.0.0.1';
      if (!secret) return '需要共享口令：/remote server --secret <口令>（token 由口令 HMAC 派生，口令不落盘不传输）';
      try {
        const srv = await startExecServer({ port, secret, dataDir: ctx.dataDir, host, defaultProfile: profile as never });
        execServerHandle = srv;
        const token = (await import('../../kernel/execServer.js')).deriveExecToken(secret);
        const warning = srv.warning ? `\n⚠ ${srv.warning}` : '';
        return `__KEEPALIVE__\nexec-server 已启动：http://${srv.host}:${srv.port}（POST /exec；token=${token.slice(0, 12)}…；远端 profile=${profile}；SIGINT 停止）${warning}\n客户端接入：/remote connect ${srv.host === '127.0.0.1' ? 'localhost' : srv.host}:${srv.port} --secret <口令>`;
      } catch (e: any) {
        return `exec-server 启动失败：${String(e?.message ?? e).slice(0, 200)}`;
      }
    }
    if (args[0] === 'connect') {
      const target = String(args[1] ?? '');
      const m = target.match(/^([^:]+):(\d+)$/);
      if (!m) return '用法：/remote connect <host:port> --secret <口令>';
      const secArg = args.indexOf('--secret');
      const secret = secArg >= 0 ? String(args[secArg + 1] ?? '') : String(ctx.config.getKey('settings', 'remoteServerSecret') ?? '');
      if (!secret) return '需要共享口令：/remote connect <host:port> --secret <口令>';
      const { deriveExecTokenClient } = await import('../../kernel/execServer.js');
      const token = deriveExecTokenClient(secret);
      ctx.config.setKey('settings', 'remoteServer', { host: m[1], port: Number(m[2]), token });
      ctx.config.setKey('settings', 'remoteServerSecret', ''); // 口令只用于派生，绝不持久化
      return `exec-server 已接入：${m[1]}:${m[2]}（token=${token.slice(0, 12)}…；bash 工具与 /remote run 此后经 exec-server 执行）`;
    }
    if (args[0] === 'off') {
      ctx.config.setKey('settings', 'remote', '');
      ctx.config.setKey('settings', 'remoteServer', null);
      return '远程目标已清除（bash 恢复本地执行）';
    }
    if (args[0] === 'status') {
      const { sshClient } = await import('../../kernel/sshRemote.js');
      return lines(' 远程执行能力 ', [
        ` ssh 客户端：${sshClient.file}（ssh 通道用）`,
        ` ssh 目标：${cur || '未配置'}`,
        ` exec-server：${curSrv ? `${curSrv.host}:${curSrv.port}（已接入）` : '未接入（/remote server 启动 + /remote connect 接入）'}`,
        ' 沙盒：exec-server 远端可沙盒（profile 参数）；ssh 通道远端未沙盒（阶段 1 口径）',
      ]);
    }
    if (args[0] === 'run') {
      const command = args.slice(1).join(' ').trim();
      if (!command) return '用法：/remote run <命令>';
      // 优先 exec-server（远端可沙盒）→ 回退 ssh 通道（远端未沙盒诚实标注）
      if (curSrv?.host && curSrv?.token) {
        const { runRemoteExecServer } = await import('../../kernel/execServer.js');
        const r = await runRemoteExecServer({ host: String(curSrv.host), port: Number(curSrv.port), token: String(curSrv.token) }, command);
        const out = `${r.out}${r.err ? `\n${r.err}` : ''}`.trim();
        return `${out || '(无输出)'}\n[exec-server ${curSrv.host}:${curSrv.port} · 退出码 ${r.code ?? '无'}${r.error ? ` · ${r.error}` : ''}]\n[${r.sandboxed ? r.note : '远端未沙盒（server 端 profile=off）'}]`;
      }
      const { parseRemoteTarget, runRemoteCommand, REMOTE_UNSANDBOXED_NOTE } = await import('../../kernel/sshRemote.js');
      const target = parseRemoteTarget(cur);
      if (!target) return '远程目标未配置——/remote connect <host:port> --secret <口令>（exec-server）或 /remote ssh://user@host（ssh）';
      const r = await runRemoteCommand(target, command, { timeoutMs: 60_000 });
      const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
      return `${out || '(无输出)'}\n[远程 ${target.user}@${target.host}:${target.port} · 退出码 ${r.code ?? '无'}${r.error ? ` · ${r.error}` : ''}]\n[${REMOTE_UNSANDBOXED_NOTE}]`;
    }
    const { parseRemoteTarget } = await import('../../kernel/sshRemote.js');
    const t = parseRemoteTarget(args[0]);
    if (!t) return '目标格式非法——ssh://user@host[:port]（或 /remote connect <host:port> --secret 接入 exec-server）';
    ctx.config.setKey('settings', 'remote', args[0]);
    return `远程目标已设置：${t.user}@${t.host}:${t.port}（bash 工具此后经 ssh 转发执行——远端未沙盒，/remote off 恢复本地）`;
  });

  bus.register('/compliance', async () => {
    const ledger = ctx.db.prepare(`SELECT COUNT(*) c FROM audit`).get() as any;
    // 审计修复：许可扫描从静态文案改为真实扫描（激活 compliance.ts 模块——
    // 此前「许可扫描：AGPL/BUSL 检测」是声称，scanLicenses 从未被调用）
    let licenseLine = ' 许可扫描：未检测到 node_modules（依赖许可未评估）';
    try {
      const { scanLicenses } = await import('../../compliance/compliance.js');
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
    const { ConsentLedger } = await import('../../compliance/compliance.js');
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

  // 2026-08-19「不真实修」：/encrypt 此前仅状态展示却挂「加密工具」描述——现真实文件加解密
  // （AES-256-GCM + scrypt；口令 --key 参数或 WXNODUS_ENC_KEY 环境变量，不落盘不回显）
  bus.register('/encrypt', async (args) => {
    const sub = args[0];
    if (sub === 'file') {
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const { encryptBytes } = await import('../../kernel/fileCrypto.js');
      const fileArg = args[1];
      if (!fileArg) return '用法：/encrypt file <文件路径> --key <口令>（加密为 <文件>.enc）｜/encrypt decrypt <文件.enc> --key <口令>';
      const keyIdx = args.indexOf('--key');
      const pass = keyIdx >= 0 ? args[keyIdx + 1] : process.env.WXNODUS_ENC_KEY;
      if (!pass) return '需要口令：--key <口令> 参数或 WXNODUS_ENC_KEY 环境变量（不落盘、不回显）';
      const target = resolve(ctx.cwd, fileArg);
      if (!existsSync(target)) return `文件不存在：${fileArg}`;
      const r = encryptBytes(readFileSync(target), pass);
      if (!r.ok) return r.error!;
      const outPath = target + '.enc';
      writeFileSync(outPath, r.data!);
      return `已加密：${outPath}（AES-256-GCM，解密：/encrypt decrypt ${fileArg}.enc --key <口令>）`;
    }
    if (sub === 'decrypt') {
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const { decryptBytes } = await import('../../kernel/fileCrypto.js');
      const fileArg = args[1];
      if (!fileArg) return '用法：/encrypt decrypt <文件.enc> --key <口令>';
      const keyIdx = args.indexOf('--key');
      const pass = keyIdx >= 0 ? args[keyIdx + 1] : process.env.WXNODUS_ENC_KEY;
      if (!pass) return '需要口令：--key <口令> 参数或 WXNODUS_ENC_KEY 环境变量';
      const target = resolve(ctx.cwd, fileArg);
      if (!existsSync(target)) return `文件不存在：${fileArg}`;
      const r = decryptBytes(readFileSync(target), pass);
      if (!r.ok) return r.error!;
      const outPath = target.endsWith('.enc') ? target.slice(0, -4) : target + '.dec';
      writeFileSync(outPath, r.data!);
      return `已解密：${outPath}`;
    }
    const enc = ctx.config.getKey('settings', 'apiKeyEnc') as string | undefined;
    return enc
      ? `凭证：AES-256-GCM 加密存储（${enc.slice(0, 12)}…，机器指纹绑定）\n文件加解密：/encrypt file <路径> --key <口令>｜/encrypt decrypt <文件.enc> --key <口令>`
      : `凭证：未配置（/model set-key <密钥>）\n文件加解密：/encrypt file <路径> --key <口令>｜/encrypt decrypt <文件.enc> --key <口令>`;
  });

  // ── 系统类 ──────────────────────────────────
  bus.register('/lang', (args) => {
    const v = args[0];
    if (v && ['zh', 'en'].includes(v)) { ctx.config.setKey('settings', 'lang', v); return `语言已切换：${v}`; }
    return `当前语言：${ctx.config.getKey('settings', 'lang') ?? 'zh'}（zh/en）`;
  });

  // 波 3 ②：/vim 切换 vim 模态编辑（settings.vimMode；gemini vimCommand.ts:9-19 对标——
  // 配置落盘 → useConfigWatcher 水合 → 输入框热生效）
  bus.register('/vim', () => {
    const cur = (ctx.config.get('settings') as Record<string, unknown> | undefined)?.vimMode === true;
    const next = !cur;
    ctx.config.setKey('settings', 'vimMode', next);
    return next
      ? '已开启 vim 模态编辑（NORMAL/INSERT 双态）：Esc 进 normal；h/j/k/l、w/b/e、0/$/^ 移动；i/a/o 插入；x/dd/dw 删除；y/p 复制粘贴；u 撤销；`.` 重复；双击 Esc 清空——/vim 再按关闭'
      : '已关闭 vim 模态编辑（回到普通输入）';
  });

  bus.register('/config', async (args) => {
    // F1 修复（2026-08-19）：export/import 分支并入本 handler——原二次注册（149 版）被 set/view 版
    // 遮蔽，功能不可达；现单注册单分发（分级表 /config export=safe、/config import=confirm 恢复真实语义）
    if (args[0] === 'export') {
      const redact = args.includes('--redact');
      const s: Record<string, any> = { ...((ctx.config.get('settings') ?? {}) as Record<string, any>) };
      if (redact) {
        delete s.apiKeyEnc;
        if (Array.isArray(s.providers)) s.providers = s.providers.map((p: any) => ({ ...p, key: p.key ? '(redacted)' : '' }));
        s.apiKeys = {};
      }
      return JSON.stringify({ settings: s }, null, 2);
    }
    if (args[0] === 'import') {
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
    // B-05 配置分层（gemini 四层对标）：项目级 .wxnodus/config.json settings 键级覆盖全局
    rows.push('', ' 分层：全局 settings.json ← 项目 .wxnodus/config.json（settings 键级覆盖，/config set 仍写全局）');
    const layers = settingsLayers(ctx.cwd);
    rows.push(`   项目配置：${layers.projectLoaded ? `✅ 已加载 ${layers.projectPath}` : layers.error ? `⚠ 解析失败（${layers.error}）` : `未配置（${layers.projectPath}）`}`);
    rows.push('', ' 导出/导入：/config export [--redact] | import <文件>（JSON 迁移/备份）');
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

}
