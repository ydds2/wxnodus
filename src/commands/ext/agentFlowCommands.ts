// src/commands/ext/agentFlowCommands.ts — 巨文件拆分第 5 块（C-6 · 批次ⅩⅩⅥ）：子代理/编排/高阶流面
// 自 handlersExt.ts 迁入：/swarm /duo /cron /jobs /agent /arena /review /session-stream /
//   /understand /delegate /btw /goal /plan /import /flow /term——嵌套 Agent 终态契约随块迁移
import { lines } from '../outputFormat.js';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCronExpr, describeCronExpr } from '../../kernel/cronExpr.js';
import { c, type HandlerCtx } from '../handlers.js';
import { commandCompletion, type CommandBus } from '../../app/CommandBus.js';
import { aggregateRunFinalStatuses, normalizeAgentRunStatus, type RunFinalStatus } from '../../protocol/runs.js';
import { isCompletionClaim } from '../../kernel/completionClaim.js';
import { sessionCost } from '../../kernel/costQuery.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../../kernel/defaults.js';
import type { TaskSpec, TaskRow } from '../../kernel/taskRunner.js';
import type { SubagentDefinition } from '../../kernel/subagentTypes.js';

interface NestedAgentResult {
  ok: boolean;
  interrupted?: boolean;
  status?: string;
}

function nestedCompletion(output: string, result: NestedAgentResult) {
  const status = normalizeAgentRunStatus(result);
  return status === 'succeeded' ? output : commandCompletion(output, status);
}

function aggregateNestedStatuses(results: readonly NestedAgentResult[]): RunFinalStatus {
  return aggregateRunFinalStatuses(results.map(normalizeAgentRunStatus));
}

export function registerAgentFlowCommands(bus: CommandBus, ctx: HandlerCtx): void {
  // /swarm <任务> [N]：N 个子代理并行执行同一任务（角色拆分提示词），汇总结果
  bus.register('/swarm', async (args, _raw, execution) => {
    let n = 3;
    if (args.length > 1 && /^\d+$/.test(args[args.length - 1]!)) n = Math.min(parseInt(args.pop()!, 10), 8);
    const goal = args.join(' ');
    if (!goal) return '用法：/swarm <任务> [并行数 1-8]（多子代理并行执行）';
    if (!ctx.agent) return commandCompletion('swarm 不可用：当前环境未提供子代理', 'blocked');
    const roles = ['（视角：结构设计）', '（视角：实现细节）', '（视角：边界与风险）', '（视角：验证与测试）', '（视角：性能优化）', '（视角：文档与交付）', '（视角：兼容性）', '（视角：复盘总结）'];
    const tasks = Array.from({ length: n }, (_, i) => `${goal}\n${roles[i % roles.length]}`);
    const settled = await Promise.allSettled(tasks.map(t => ctx.agent!.spawnSubagent(t, undefined, undefined, { signal: execution.signal })));
    const results = settled.map(r => r.status === 'fulfilled'
      ? r.value
      : { ok: false, interrupted: execution.signal?.aborted, output: `异常：${(r.reason as any)?.message ?? r.reason}`, turns: 0 });
    const body: string[] = [];
    results.forEach((result, i) => {
      body.push('', ` ══ 子代理 ${i + 1} ${result.ok ? '✓' : '✗'}（${result.turns} 轮）══`, ...String(result.output ?? '').split('\n').slice(0, 10).map(l => `  ${l.slice(0, 108)}`));
    });
    const output = lines(` 集群执行 ${goal.slice(0, 30)} `, [` ${n} 个子代理并行（只读工具集）`, ...body]);
    const status = aggregateNestedStatuses(results);
    return status === 'succeeded' ? output : commandCompletion(output, status);
  });

  // /duo <任务>：双脑协作——两个子代理独立方案 + 交叉对比汇总
  bus.register('/duo', async (args, _raw, execution) => {
    const goal = args.join(' ');
    if (!goal) return '用法：/duo <任务>（双脑协作：两方案独立推演 + 对比）';
    if (!ctx.agent) return commandCompletion('duo 不可用：当前环境未提供子代理', 'blocked');
    const [a, b] = await Promise.all([
      ctx.agent.spawnSubagent(`${goal}\n（请输出完整方案 A，含步骤与理由）`, undefined, undefined, { signal: execution.signal }),
      ctx.agent.spawnSubagent(`${goal}\n（请输出完整方案 B，含步骤与理由，尽量与直觉方案不同）`, undefined, undefined, { signal: execution.signal }),
    ]);
    const output = lines(` 双脑 ${goal.slice(0, 26)} `, [
      ` ══ 方案 A ${a.ok ? '✓' : '✗'}（${a.turns} 轮）══`,
      ...String(a.output ?? '').split('\n').slice(0, 14).map(l => `  ${l.slice(0, 108)}`),
      '',
      ` ══ 方案 B ${b.ok ? '✓' : '✗'}（${b.turns} 轮）══`,
      ...String(b.output ?? '').split('\n').slice(0, 14).map(l => `  ${l.slice(0, 108)}`),
    ]);
    const status = aggregateNestedStatuses([a, b]);
    return status === 'succeeded' ? output : commandCompletion(output, status);
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
  bus.register('/jobs', async (args, _raw, execution) => {
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
      // V4 P2-12：循环加取消信号检查 + sleep 可被 abort 打断（取消后即时返回不挂满 120s）
      while (Date.now() < deadline && !execution.signal?.aborted) {
        const final0 = tr.get(id);
        if (final0 && (final0.status === 'success' || final0.status === 'failed' || final0.status === 'cancelled')) break;
        try {
          if (existsSync(t.log_file)) {
            const text = readFileSync(t.log_file, 'utf8');
            if (text.length > pos) { out.push(text.slice(pos)); pos = text.length; }
          }
        } catch { /* 读失败重试 */ }
        await new Promise<void>(r => {
          const timer = setTimeout(r, 2000);
          execution.signal?.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true });
        });
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
  bus.register('/agent', async (args, _raw, execution) => {
    const { loadAgentDefs, findAgentDef } = await import('../../kernel/agents.js');
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
      if (!ctx.agent) return commandCompletion('agent 不可用：当前环境未提供子代理能力', 'blocked');
      ctx.bus.emit('system.notice', { text: `派发 agent「${name}」：「${task.slice(0, 60)}」…` });
      const r = await ctx.agent.spawnSubagent(task, undefined, {
        systemPromptOverride: def.instructions,
        mode: def.mode,
        tools: def.tools,
      }, { signal: execution.signal });
      const output = lines(` agent「${name}」结果 `, [
        ` 任务：${task.slice(0, 80)}`,
        ` 状态：${r.ok ? '完成' : '未完成'}（${r.turns} 轮）`,
        '',
        ...String(r.output ?? '').split('\n').slice(0, 30).map(l => ` ${l.slice(0, 110)}`),
      ]);
      return nestedCompletion(output, r);
    }
    return '用法：/agent list｜/agent run <agent名> <任务>';
  });

  // P2-全方面：/arena——多模型对战（Qwen Agent Arena 对齐，差异化杀手锏）
  // 同一任务依次用两个模型执行（主模型 + 指定/自动次选），输出对比面板 + 全文落盘
  bus.register('/arena', async (args, _raw, execution) => {
    const mIdx = args.indexOf('--model');
    const m2 = mIdx >= 0 ? String(args[mIdx + 1] ?? '') : '';
    const task = args.filter((a, i) => a !== '--model' && args[i - 1] !== '--model').join(' ').trim();
    if (!task) return '用法：/arena <任务> [--model <次选模型id>]（双模型对战选优，结果落盘 data/arena-*）';
    if (!ctx.agent) return commandCompletion('arena 不可用：当前环境未提供 agent', 'blocked');
    const { resolveApiKey, MODEL_CATALOG } = await import('../../kernel/providers.js');
    const { resolveDefaultModel } = await import('../../kernel/defaults.js');
    const settings = ctx.config.get('settings') as {
      apiKeyEnc?: string | null;
      apiKeys?: Record<string, string> | null;
      keyProvider?: string | null;
      baseURL?: string;
      model?: string;
    };
    const cur = settings.model && MODEL_CATALOG.some(m => m.modelId === settings.model) ? settings.model : resolveDefaultModel(settings);
    const currentEntry = MODEL_CATALOG.find(m => m.modelId === cur);
    // 次选：--model 指定 ｜ 同 provider 备选 ｜ 目录中第一个不同模型
    let second = '';
    if (m2) {
      if (!MODEL_CATALOG.some(m => m.modelId === m2)) return `模型「${m2}」不在目录（/model 查看可用模型）`;
      second = m2;
    } else {
      const sameProv = MODEL_CATALOG.find(m => m.provider === currentEntry?.provider && m.modelId !== cur);
      second = sameProv?.modelId ?? MODEL_CATALOG.find(m => m.modelId !== cur)?.modelId ?? '';
    }
    const secondEntry = MODEL_CATALOG.find(m => m.modelId === second);
    if (!second || !secondEntry) return commandCompletion('无可用次选模型', 'blocked');

    const contestants = [
      { modelId: cur, baseURL: currentEntry?.baseURL ?? settings.baseURL },
      { modelId: second, baseURL: secondEntry.baseURL },
    ];
    for (const contestant of contestants) {
      if (contestant.modelId.startsWith('offline:')) continue;
      const keyRes = resolveApiKey({ ...settings, baseURL: contestant.baseURL });
      if (!keyRes.key) {
        const hint = keyRes.hint ? `：${keyRes.hint}` : '——/model set-key <密钥> 后可用';
        return commandCompletion(`arena 模型 ${contestant.modelId} 缺少可用密钥${hint}`, 'blocked');
      }
    }

    const agent = ctx.agent;
    ctx.bus.emit('system.notice', { text: `arena 对战开始：${cur} vs ${second}「${task.slice(0, 40)}」…` });
    const ts = Date.now().toString(36);
    type ArenaResult = NestedAgentResult & { modelId: string; turns: number; text: string };
    const run = async (modelId: string, baseURL: string | undefined, sessionId: string): Promise<ArenaResult> => {
      try {
        const r = await agent.spawnSubagent(task, undefined, { model: modelId, baseURL }, {
          signal: execution.signal,
          sessionId,
        });
        return { modelId, ok: r.ok, turns: r.turns, text: r.output, interrupted: r.interrupted, status: r.status };
      } catch (e: any) {
        const cancelled = execution.signal?.aborted === true;
        return {
          modelId,
          ok: false,
          turns: 0,
          text: `执行失败：${String(e?.message ?? e).slice(0, 200)}`,
          interrupted: cancelled,
          status: cancelled ? 'cancelled' : 'failed',
        };
      }
    };
    const [a, b] = await Promise.all([
      run(contestants[0]!.modelId, contestants[0]!.baseURL, `arena-a-${ts}`),
      run(contestants[1]!.modelId, contestants[1]!.baseURL, `arena-b-${ts}`),
    ]);
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
    const output = lines(` Arena 对战「${task.slice(0, 24)}」 `, [
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
    const status = aggregateNestedStatuses([a, b]);
    return status === 'succeeded' ? output : commandCompletion(output, status);
  });

  // 深度：/review——任务自查（Codex /review 对齐）——AI 以审查者视角复查刚完成的工作
  // 内置审查指令（不依赖用户 agent 文件）；可指定审查范围（文件/目录/最近改动）
  bus.register('/review', async (args, _raw, execution) => {
    const scope = args.join(' ').trim();
    if (!ctx.agent) return commandCompletion('review 不可用：当前环境未提供 agent', 'blocked');
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
    }, { signal: execution.signal });
    const output = lines(` 自查结果（${r.turns} 轮） `, [
      ...String(r.output ?? '').split('\n').slice(0, 40).map(l => ` ${l.slice(0, 110)}`),
      r.ok ? '' : ' ⚠ 审查未完整执行（无密钥时需 /key set 后使用 AI 审查）',
    ]);
    return nestedCompletion(output, r);
  });

  // 架构 P3：/session-stream——会话事件流查看/导出（可重放/审计；Claude Code 会话流对齐）
  bus.register('/session-stream', async (args) => {
    const { listSessionStreams, readSessionEvents } = await import('../../kernel/sessionStream.js');
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
    const { scanProject } = await import('../../kernel/projectScan.js');
    const { buildRepoMap } = await import('../../kernel/repoMap.js');
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
    const { resolveApiKey, MODEL_CATALOG } = await import('../../kernel/providers.js');
    const { resolveDefaultModel, resolveDefaultBaseURL } = await import('../../kernel/defaults.js');
    const keyRes = resolveApiKey(settings);
    let concept: { title: string; summary: string; modules: string[]; domain: string[]; acceptance: string[] } | null = null;
    let source = '规则提炼';
    if (keyRes.key) {
      const { callModelOnce, extractJson } = await import('../../kernel/llmOnce.js');
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
  bus.register('/delegate', async (args, _raw, execution) => {
    // W3 Subagent 第 1 步：组合路由决策——modern/required 在 live process host 接线完成前 fail-closed
    const { decideSubagentRoute } = await import('../extensionRouting.js');
    const subagentRoute = decideSubagentRoute({ env: process.env.WXNODUS_COMPOSITION_ROOT });
    if (!subagentRoute.ok) {
      throw new Error(`[${subagentRoute.error.code}] ${subagentRoute.error.message}`);
    }
    // modern 路由只使用组合根持有的 manager：命令结束后活动表、终止端口和 shutdown 仍可达。
    if (subagentRoute.value.route === 'modern') {
      const manager = ctx.delegateManager;
      if (!manager) return commandCompletion('delegate modern 生命周期未装配', 'blocked');

      const subcommand = args[0];
      if (subcommand === '--status' || subcommand === 'status') {
        const active = manager.listActive();
        return lines(' 子代理状态 ', active.length
          ? active.map(task => `${task.taskId} · pid ${task.processId} · ${task.goal.slice(0, 80)}`)
          : ['无活动子代理']);
      }
      if (subcommand === '--stop' || subcommand === 'stop') {
        const taskId = String(args[1] ?? '').trim();
        if (!taskId) return commandCompletion('用法：/delegate --stop <taskId>', 'failed');
        const stopped = await manager.stop(taskId);
        if (!stopped.ok) {
          return commandCompletion(`子代理 ${taskId} 终止失败：${stopped.error ?? stopped.status}`, stopped.status);
        }
        return `子代理 ${taskId} 已终止并清理 worktree`;
      }
      if (args.includes('--agent')) {
        return commandCompletion('modern process 委派不支持 --agent；自定义 agent 定义仅适用于 legacy 内嵌委派', 'blocked');
      }

      const goal = args.join(' ').trim();
      if (!goal) return '用法：/delegate <任务> | /delegate --status | /delegate --stop <taskId>';
      if (ctx.liveDelegateHost !== true) {
        return commandCompletion('一次性命令不能持有 live 子代理；请在 TUI 或 serve 长驻宿主中执行 /delegate', 'blocked');
      }
      const started = await manager.start({
        goal,
        parentContext: execution.runContext,
        sessionId: execution.runContext?.sessionId ?? ctx.agent?.getSessionId?.(),
        signal: execution.signal,
      });
      if (!started.ok) {
        return commandCompletion(`子代理启动失败：[${started.error.code}] ${started.error.message}`, 'failed');
      }
      const task = started.value;
      return lines(' 子代理已启动（live process host） ', [
        ` receipt：${task.taskId}（pid ${task.processId}）`,
        ` run：${task.runContext.runId} · correlation ${task.runContext.correlationId}`,
        ` worktree：${task.worktreePath}`,
        ` 停：/delegate --stop ${task.taskId}`,
      ]);
    }
    const agentIdx = args.indexOf('--agent');
    let agentName: string | null = null;
    if (agentIdx >= 0) agentName = String(args[agentIdx + 1] ?? '');
    const task = args.filter((a, i) => a !== '--agent' && args[i - 1] !== '--agent').join(' ').trim();
    if (!task) return '用法：/delegate <任务> [--agent <自定义agent名>]（派发子代理，结果返回当前会话）';
    if (!ctx.agent) return commandCompletion('delegate 不可用：当前环境未提供子代理能力', 'blocked');
    ctx.bus.emit('system.notice', { text: `派发子代理：「${task.slice(0, 60)}」…` });
    const id = `t${Date.now().toString(36)}`;
    try {
      ctx.db.prepare(`INSERT INTO tasks (id, goal, status, created_at) VALUES (?,?,?,?)`).run(id, `delegate: ${task.slice(0, 180)}`, 'running', Date.now());
    } catch { /* 任务表未就绪时跳过持久化 */ }
    try {
      // P0-2：--agent 指定定义时按定义派发（指令/模式/工具白名单生效）
      let def: SubagentDefinition | undefined;
      if (agentName) {
        const { findAgentDef } = await import('../../kernel/agents.js');
        const d = findAgentDef(agentName, ctx.cwd, ctx.dataDir);
        if (!d) {
          const output = `agent「${agentName}」不存在（/agent list 查看）`;
          try { ctx.db.prepare(`UPDATE tasks SET status='failed', output=?, done_at=? WHERE id=?`).run(output, Date.now(), id); } catch { /* 忽略 */ }
          return commandCompletion(output, 'failed');
        }
        def = { systemPromptOverride: d.instructions, mode: d.mode, tools: d.tools };
      }
      const r = await ctx.agent.spawnSubagent(task, undefined, def, { signal: execution.signal });
      const status = normalizeAgentRunStatus(r);
      // 结果持久化（机制补强）：/jobs show <id> 可查看历史
      try {
        ctx.db.prepare(`UPDATE tasks SET status=?, output=?, done_at=? WHERE id=?`).run(status, String(r.output).slice(0, 4000), Date.now(), id);
      } catch { /* 忽略 */ }
      const output = lines(` 子代理结果 `, [
        ` 任务：${task.slice(0, 80)}`,
        ` 状态：${status === 'succeeded' ? '完成' : '未完成'}（${r.turns} 轮）｜记录：/jobs show ${id}`,
        '',
        ...String(r.output ?? '').split('\n').slice(0, 30).map(l => ` ${l.slice(0, 110)}`),
      ]);
      return status === 'succeeded' ? output : commandCompletion(output, status);
    } catch (e: any) {
      const status: RunFinalStatus = execution.signal?.aborted ? 'cancelled' : 'failed';
      const output = `子代理执行异常：${e?.message?.slice(0, 300) ?? e}`;
      try { ctx.db.prepare(`UPDATE tasks SET status=?, output=?, done_at=? WHERE id=?`).run(status, output, Date.now(), id); } catch { /* 忽略 */ }
      return commandCompletion(output, status);
    }
  });

  // /btw：侧边提问（机制补强）——隔离只读上下文并行问答，不打断主对话
  bus.register('/btw', async (args, _raw, execution) => {
    const q = args.join(' ');
    if (!q) return '用法：/btw <问题>（隔离只读上下文侧边提问，不占用主对话）';
    if (!ctx.agent) return commandCompletion('btw 不可用：当前环境未提供子代理', 'blocked');
    const r = await ctx.agent.spawnSubagent(`（侧边提问，请直接简要回答，不调用工具）${q}`, undefined, undefined, { signal: execution.signal });
    const output = lines(` 侧边提问 `, [
      ` Q：${q.slice(0, 80)}`,
      ` A（${r.ok ? '完成' : '未完成'}，${r.turns} 轮）：`,
      ...String(r.output ?? '').split('\n').slice(0, 15).map(l => `  ${l.slice(0, 108)}`),
    ]);
    return nestedCompletion(output, r);
  });

  // /goal：开放目标循环执行——逐轮推进直到完成或达到最大轮数（真实 agent 执行）

  bus.register('/goal', async (args, _raw, execution) => {
    const maxIter = args.length > 1 && /^\d+$/.test(args[args.length - 1]!) ? parseInt(args.pop()!, 10) : 3;
    const goal = args.join(' ');
    if (!goal) return '用法：/goal <目标> [最大轮数]（循环执行直到完成或达上限）';
    if (!ctx.agent) return commandCompletion('goal 不可用：当前环境未提供 agent', 'blocked');
    // 护栏明示（余额耗尽场景防线）：goal 循环是烧钱大户——启动时报告护栏状态
    const s = (ctx.config.get('settings') ?? {}) as Record<string, any>;
    const bm = (s.balanceMonitor ?? {}) as Record<string, any>;
    const budget = Number(s.budgetTokens) || 0;
    const hardStop = s.budgetStop === true;
    const autoStop = bm.autoStop === true;
    const guardNote = `（护栏：余额 auto-stop ${autoStop ? '开 ✓' : '关'}｜token 预算 ${budget ? `${budget}${hardStop ? ' 硬停 ✓' : ''}` : '未设'}${autoStop || (budget && hardStop) ? '' : '——/balance auto-stop on 或 /config set budgetTokens N budgetStop true 防超支'}）`;
    const rounds: string[] = [];
    const notes: string[] = [];
    // V4 P2-9：产物基线——任务开始前 projects/ 的最新目录名。验证只认本轮新建/变更项目
    // （此前取「任意最新旧项目」：模型带 ✅ 输出 + 恰有旧可启动项目 → 假完成 succeeded）
    const projectsDirBase = join(ctx.dataDir, 'projects');
    const baselineProject = existsSync(projectsDirBase)
      ? readdirSync(projectsDirBase).filter(n => n.startsWith('p')).sort().at(-1) ?? null
      : null;
    const cap = Math.min(maxIter, 8);
    const goalStartedAt = Date.now(); // V4 P2-9：产物变更判定基准
    let done = false;
    let finalStatus: RunFinalStatus = 'incomplete';
    for (let i = 1; i <= cap; i++) {
      // A24：goal 进度实时上报（UI 后台面板「目标循环」区——与内核 goal 模式同事件）
      try { ctx.bus?.emit('agent.goal', { round: i, maxRounds: cap, done: false, cancelled: false, text: goal.slice(0, 80) }); } catch { /* 事件失败不阻断 */ }
      const prompt = `目标：${goal}\n当前进度：${rounds.at(-1) ? '已完成以下工作——' + rounds.at(-1)!.slice(0, 600) : '尚未开始'}。\n请继续推进目标。若目标已全部完成，以「✓ 已完成」开头输出总结；否则输出本轮完成的事项与下一步。`;
      // goalLoop:false——/goal 命令自身循环，显式关闭内核 goal 模式内层循环（防 8×10 嵌套）
      const r = await ctx.agent.run(prompt, { goalLoop: false, signal: execution.signal });
      rounds.push(r.text);
      const runStatus = normalizeAgentRunStatus(r);
      // 中断（Ctrl+C/Esc×2）：如实 cancelled 结束，不空转剩余轮次
      if (runStatus === 'cancelled') { finalStatus = 'cancelled'; break; }
      // V4 P2-9（假完成根治）：仅行首完成声明触发验证——裸 includes('✅') 已删（模型输出
      // 清单/引用/表情里任意位置的 ✅ 均触发假验证）；prompt 约定「以 ✓ 已完成 开头」故行首匹配
      const completionClaim = isCompletionClaim(r.text) || /^✓ 已完成/m.test(r.text);
      if (completionClaim) {
        // A22 诚实交付：声称完成 ≠ 完成——有构建产物（projects/ 有项目）才跑真实验证
        // （启动→探活→重启→读回）；验证通过才判完成，无产物/验证失败均不判完成（KF-023 语义）
        const projectsDir = join(ctx.dataDir, 'projects');
        const proj = existsSync(projectsDir) ? readdirSync(projectsDir).filter(n => n.startsWith('p')).sort().at(-1) : null;
        // V4 P2-9：本轮无新产物（最新项目 == 基线且未变更）→ 不验证不判完成（诚实 incomplete）
        const projectChanged = proj !== null && (proj !== baselineProject
          || statSync(join(projectsDir, proj)).mtimeMs > goalStartedAt);
        if (proj && !projectChanged) {
          notes.push('⚠ 声称完成但本轮无新建/变更产物（最新项目为任务前基线）——不判完成，诚实 incomplete');
          finalStatus = 'incomplete';
          break;
        }
        if (!proj) {
          notes.push('⚠ 声称完成但无产物可验证（未验证）——不判完成，诚实 incomplete');
          finalStatus = 'incomplete';
          break;
        }
        try {
          const { verifyProject } = await import('../../build/verify.js');
          const vr = await verifyProject(join(projectsDir, proj));
          if (vr.status === 'ok') { done = true; finalStatus = 'succeeded'; break; }
          notes.push(`⚠ 声称完成但验证未通过：${vr.detail.slice(0, 160)}`);
        } catch (e: any) {
          // fail-closed：验证异常绝不视为通过（此前 catch { verified = true } 假绿）
          notes.push(`⚠ 声称完成但验证异常（未验证）：${e?.message?.slice(0, 160) ?? e}`);
        }
        finalStatus = 'incomplete';
        continue;
      }
      if (r.text.includes('未配置模型密钥')) { finalStatus = 'blocked'; break; }
      if (runStatus !== 'succeeded') { finalStatus = runStatus; break; }
    }
    const cancelled = finalStatus === 'cancelled';
    try { ctx.bus?.emit('agent.goal', { round: done || cancelled ? rounds.length : cap, maxRounds: cap, done, cancelled, text: rounds.at(-1)?.slice(0, 80) ?? '' }); } catch { /* 忽略 */ }
    const output = lines(` 目标执行 ${done ? '✓ 完成' : cancelled ? '已取消' : `（${rounds.length} 轮）`} `, [
      ` 目标：${goal.slice(0, 80)}`,
      guardNote,
      ...rounds.map((r, i) => ['', ` ── 第 ${i + 1} 轮 ──`, ...String(r).split('\n').slice(0, 12).map(l => ` ${l.slice(0, 110)}`)]).flat(),
      ...notes,
      ...(rounds.length >= cap && !done && !cancelled ? [' ⚠ 已达轮次上限仍未验证完成（诚实 incomplete）'] : []),
    ]);
    return finalStatus === 'succeeded' ? output : commandCompletion(output, finalStatus);
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
      const { resolveApiKey } = await import('../../kernel/providers.js');
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (!keyRes.key) return '未配置模型密钥——/key set <密钥> 后 /plan save 才能生成计划（不产生假内容）';
      if (keyRes.error === 'decrypt-failed') return '密钥无法解密——请 /key set <密钥> 重新配置';
      const key = keyRes.key;
      const goal = rest.join(' ').trim() || String(ctx.mem.recall(sid).filter(m => m.role === 'user').at(-1)?.content ?? '').slice(0, 500);
      if (!goal) return '没有可规划的需求——/plan save <需求描述> 或先对话几轮';
      try {
        const { buildChatRequest } = await import('../../kernel/providers.js');
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

  // /import <文件>：导入消息回填会话。V4 P4-4 增强竞品会话格式嗅探
  // （kimi /import-from-cc-codex 实证有效——降低 Claude Code/Codex 用户切换成本）：
  //   ① 竞品 JSONL 自动识别（claude projects / codex rollout——结构特征判定）
  //   ② 自有 JSON [{role,content}] / /export --jsonl
  //   ③ 纯文本 → user 消息兜底
  bus.register('/import', async (args) => {
    const path = args[0];
    if (!path) return '用法：/import <文件路径>（自有 JSON/JSONL、Claude Code/Codex 会话 JSONL、纯文本）';
    // 审计修复：会话统一——导入到当前会话（此前硬编码 default）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    let text = '';
    try { text = readFileSync(resolve(process.cwd(), path), 'utf8'); } catch { return `无法读取文件：${path}`; }
    let imported = 0;
    const ins = ctx.db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, ts) VALUES (?,?,?,?,?)`);
    const now = Date.now();
    const push = (role: string, content: string, ts?: number) => {
      if (!['user', 'assistant', 'system'].includes(role)) return;
      ins.run(sid, role, content, null, ts ?? now + imported);
      imported++;
    };
    // V4 P4-4：竞品 JSONL 嗅探先行（整体 JSON.parse 对 JSONL 必然失败——先于旧路径判定，
    // claude/codex 的行结构 {message|payload} 与自有 {role,content} 由引擎统一识别）
    try {
      const { parseExternalSessionJsonl } = await import('../../kernel/sessionImport.js');
      const parsed = parseExternalSessionJsonl(text);
      if (parsed.kind !== 'unknown' && parsed.messages.length) {
        for (const m of parsed.messages) push(m.role, m.content, m.ts);
        const kindLabel = { claude: 'Claude Code', codex: 'Codex', wxnodus: 'wxnodus' }[parsed.kind];
        return `已识别 ${kindLabel} 会话格式——导入 ${imported} 条消息到当前会话（/resume 或直接继续对话）`;
      }
    } catch { /* 嗅探失败走旧路径 */ }
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
      if (!imported) { ctx.mem.append(sid, 'user', text); imported = 1; }
    }
    return `已导入 ${imported} 条消息到当前会话（/resume 或直接继续对话）`;
  });

  // /flow <需求>：AI 生成流程图（Mermaid）写入 data/flow/（参考 flow 技能的落地替代）
  bus.register('/flow', async (args, _raw, execution) => {
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
      const node = nodes[next]!;
      if (!ctx.agent) return commandCompletion('flow 不可用：当前环境未提供 agent', 'blocked');
      const result = await ctx.agent.run(
        `（流程「${run.skill}」步骤 ${next + 1}/${nodes.length}：${node.name}）执行以下步骤并完成后简要汇报：\n${node.instruction}`,
        { signal: execution.signal },
      );
      const status = normalizeAgentRunStatus(result);
      if (status !== 'succeeded') {
        return commandCompletion(
          `流程「${run.skill}」步骤 ${next + 1}/${nodes.length} 未完成，游标未推进：${result.text.slice(0, 300)}`,
          status,
        );
      }
      ctx.db.prepare(`UPDATE flow_runs SET current=? WHERE id=?`).run(next, run.id);
      return `▶ 流程「${run.skill}」推进到步骤 ${next + 1}/${nodes.length}：${node.name}（/flow next 继续，/flow status 查看进度）`;
    }
    const skillName = sub ?? '';
    if (skillName && skillName !== 'mermaid' && !/[\s，。]/.test(skillName)) {
      // 技能名 → 技能流程启动（技能未定义流程时回落到 AI 生成）
      const { loadSkill, parseFlow } = await import('../../kernel/skills.js');
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
          if (!ctx.agent) return commandCompletion('flow 不可用：当前环境未提供 agent', 'blocked');
          const result = await ctx.agent.run(
            `（流程「${skillName}」步骤 ${run.current + 1}/${flow.length}：${node.name}）执行以下步骤并完成后简要汇报：\n${node.instruction}`,
            { signal: execution.signal },
          );
          const status = normalizeAgentRunStatus(result);
          if (status !== 'succeeded') {
            return commandCompletion(
              `流程「${skillName}」步骤 ${run.current + 1}/${flow.length} 未完成：${result.text.slice(0, 300)}`,
              status,
            );
          }
          return `▶ 流程「${skillName}」步骤 ${run.current + 1}/${flow.length}：${node.name}（/flow next 推进，/flow status 查看进度）`;
        }
      }
    }
    // ── AI 生成 Mermaid 流程图（默认路径）──
    const goal = args.join(' ').trim();
    if (!goal) return '用法：/flow <流程需求> ｜ /flow <技能名>（技能流程）｜ /flow next｜status｜cancel';
    const { resolveApiKey } = await import('../../kernel/providers.js');
    const keyRes = resolveApiKey(ctx.config.get('settings') as any);
    if (!keyRes.key) return '未配置模型密钥——/key set <密钥> 后 /flow 才能生成流程图';
    if (keyRes.error === 'decrypt-failed') return '密钥无法解密——请 /key set <密钥> 重新配置';
    const key = keyRes.key;
    try {
      const { buildChatRequest } = await import('../../kernel/providers.js');
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
      const r = await tm.kill(id);
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
}
