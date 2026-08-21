// src/commands/handlersExt.ts — 扩展命令处理器（registry 实测 108 条——此计数与 SLASH 长度同步，勿回写旧值）
// 设计：与 handlers.ts 分离，按类补齐——工具（确定性）/会话/记忆/构建/安全/
//       系统/视觉/连接/协作。每个命令真实可用（查询现有数据或执行确定性操作），
//       输出统一 lines()（标题+缩进条目，纯文本）或单行。红线：只读工具不写库；路径操作限制在 dataDir。
// 2026-08-19 输出格式体系（docs/output-format-spec-2026.md）：命令输出 = 标题行
// + 两格缩进条目（纯文本、无边框——与 handlers.ts 同构）
const lines = (title: string, body: string[]): string =>
  [title, ...body.map(l => `  ${l}`)].join('\n');
import { basename, join, resolve, relative, normalize, sep } from 'node:path';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { appendAudit } from '../store/db.js';
import { isCompletionClaim } from '../kernel/completionClaim.js';
import { parseCronExpr, describeCronExpr } from '../kernel/cronExpr.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from '../kernel/defaults.js';
import { loadPermRules, savePermRules } from '../kernel/permissions.js';
import { sessionCost } from '../kernel/costQuery.js';
import { labelTruncate } from '../kernel/truncate.js';
import { WXNODUS_VERSION } from '../kernel/version.js';
import type { TaskSpec, TaskRow } from '../kernel/taskRunner.js';
import { c, type HandlerCtx } from './handlers.js';
import { registerDeterministicTools } from './ext/deterministicTools.js';
import { commandCompletion, type CommandBus } from '../app/CommandBus.js';
import { httpStatusForCompletion } from '../protocol/completionTransport.js';
import { aggregateRunFinalStatuses, normalizeAgentRunStatus, type RunFinalStatus } from '../protocol/runs.js';
import type { SubagentDefinition } from '../kernel/subagentTypes.js';
import { registerSessionCommands } from './ext/sessionCommands.js';

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
import { registerProfileMemoryBuildCommands } from './ext/profileMemoryBuildCommands.js';
// renderWaterfall/parseProfileAddArgs/parseBalanceSetArgs 已迁至 ext 模块（拆分第 2/3 块 audit §13.46）——re-export 保持导入兼容
export { renderWaterfall } from './ext/sessionCommands.js';
export { parseProfileAddArgs, parseBalanceSetArgs } from './ext/profileMemoryBuildCommands.js';

// fsLsRows/fsReadRows/sqlTableRows 已迁至 ext/deterministicTools.ts（巨文件拆分 audit §13.43）——re-export 保持测试导入兼容
export { fsLsRows, fsReadRows, sqlTableRows } from './ext/deterministicTools.js';

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
export function registerExtHandlers(bus: CommandBus, ctx: HandlerCtx): void {
  // 启动时订阅既有 webhook 配置（热注册由 /webhook add 处理）
  subscribeWebhooks(ctx);
  // ── 会话/系统工具类已迁至 ext/sessionCommands.ts（拆分第 2 块 audit §13.46）──
  registerSessionCommands(bus, ctx);
  // ── 档案/记忆/构建/安全/系统类已迁至 ext/profileMemoryBuildCommands.ts（拆分第 3 块 audit §13.46）──
  registerProfileMemoryBuildCommands(bus, ctx);

  // /migrate [status|run]：用户产物迁移框架（V4 P5-2——约束四·迁移兼容权）
  //   status：产物清单兼容状态（ok/missing/corrupt）+ 迁移历史 + 待执行迁移器
  //   run：detects→备份→原子应用→失败整体回滚（绝不半迁移）
  bus.register('/migrate', async (args) => {
    const { artifactStatus, runMigrations, migrationHistory, ARTIFACT_MIGRATORS } = await import('../kernel/artifactMigration.js');
    const sub = args[0] ?? 'status';
    if (sub === 'run') {
      const r = runMigrations(ctx.dataDir);
      return lines(' 迁移执行 ', [
        ...r.steps.map(s => ` ${s}`),
        ...(r.applied.length ? [` 已应用：${r.applied.join('、')}`] : []),
        ...(r.ok ? [] : [` ✗ ${r.error}`]),
        ...(r.backupDir ? [` 备份：${r.backupDir}（回滚出口）`] : []),
      ]);
    }
    if (sub !== 'status') return '用法：/migrate status（产物兼容状态）｜ /migrate run（执行迁移——自动备份+失败整体回滚）';
    const st = artifactStatus(ctx.dataDir);
    const hist = migrationHistory(ctx.dataDir);
    const pending = ARTIFACT_MIGRATORS.filter(m => { try { return m.detects(ctx.dataDir); } catch { return false; } });
    return lines(' 产物迁移 ', [
      ...st.map(s => ` ${s.state === 'ok' ? '✓' : s.state === 'missing' ? '·' : '✗'} ${s.spec.id}（${s.spec.path}）${s.state === 'ok' ? `——${s.note}` : s.state === 'missing' ? '——未创建（新装合法）' : `——${s.note}`}`),
      ` 待执行迁移：${pending.length ? pending.map(m => m.id).join('、') : '无（形态均已是当前版本）'}`,
      ` 迁移历史：${hist.length ? `${hist.length} 条（最近 ${new Date(hist[hist.length - 1]!.at).toLocaleString('zh-CN', { hour12: false })}）` : '无'}`,
      ' 说明：升级绝不丢用户资产——/migrate run 自动备份到 migrations/backups/，任一步失败整体回滚',
    ]);
  });

  // /eco —— Windows 生态互依状态面板（真实探测、结果缓存——反复打开不反复 spawn）
  bus.register('/eco', async () => {
    const { renderEcosystem } = await import('../application/ecosystemStatus.js');
    return renderEcosystem(ctx.dataDir);
  });
  // ── 工具类（确定性）已迁至 ext/deterministicTools.ts（巨文件拆分 audit §13.43）──
  registerDeterministicTools(bus, ctx);

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
    if (!ctx.gateway?.requestCredentialForm) return '动态内容表需 TUI 会话（-p 非交互不可用）——配置密钥请用 /model set-key';
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
            // policy 决策如实标记：高影响动作 requiresApproval=true（真正的授权门在 approvals.authorize
            // ——审批桥缺失即 fail-closed；此处标记与 authorize 的 isHighImpactKind 裁决同源）
            const requiresApproval = isHighImpactKind((effect as { kind?: string } | null)?.kind ?? '');
            return { ok: true as const, value: { allow: true, requiresApproval } };
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
        const r = await uiaWindows();
        if (!r.ok) return r.reason ?? 'UIA 不可用';
        return lines(' UIA 可见窗口 ', (r.windows ?? []).map(w => ` ${w.focused ? '◉' : '○'} 「${w.name.slice(0, 40)}」 pid=${w.pid} handle=${w.handle}`));
      }
      if (sub === 'tree') {
        const r = await uiaTree(args[2] ?? '');
        if (!r.ok) return r.reason ?? 'UIA 不可用';
        return lines(` UIA 控件树（${(r.elements ?? []).length}） `, (r.elements ?? []).map(e =>
          ` ${e.name ? `「${e.name.slice(0, 30)}」` : ''}${e.id ? ` id=${e.id}` : ''} <${e.ct}> @(${e.x},${e.y})`));
      }
      if (sub === 'find') {
        const q = args.slice(2).join(' ');
        if (!q) return '用法：/computer uia find <名称>|<AutomationId>';
        const r = await uiaFind(q);
        if (!r.ok) return r.reason ?? '未找到';
        const e = r.element as any;
        return `已定位：${e?.name ? `「${e.name}」` : ''}${e?.id ? ` id=${e.id}` : ''} <${e?.ct ?? ''}> @(${e?.x},${e?.y} ${e?.w}x${e?.h})`;
      }
      if (sub === 'click') {
        const q = args.slice(2).join(' ');
        if (!q) return '用法：/computer uia click <名称>|<AutomationId>';
        const r = await uiaClick(q);
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
        const r = await uiaType(text, q);
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

  bus.register('/render', async (args) => {
    const target = args.join(' ');
    if (!target) return '用法：/render <Markdown 文本>（真实渲染：标题/列表/代码块/表格/引用/公式——与 TUI 同源解析器）';
    // 2026-08-19「不真实修」：此前仅行级前缀变换却挂「Markdown 排版预览」——现复用
    // 成熟解析器（micromark+GFM+math，与 TUI 渲染同源）真实渲染为文本
    const { renderMarkdownText } = await import('../wxnodus-ui/lib/markdown/renderText.js');
    const out = renderMarkdownText(target);
    if (!out.length) return '（空输入或无内容）';
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
      if (sub === 'install' && name) {
        // 第三方插件接收（S-02 接收侧，2026-08-18）：目录 / zip / https URL —— SSRF 防护下载 +
        // 包结构校验 + 可选 --sha256 完整性校验 + staging 原子落位 + 启用失败回滚
        const shaFlag = rest.findIndex((a) => a === '--sha256');
        const expectedSha256 = shaFlag >= 0 ? rest[shaFlag + 1] : undefined;
        const { installPluginPackage } = await import('../application/extensions/pluginInstaller.js');
        const r = await installPluginPackage({
          source: name,
          dataDir: ctx.dataDir,
          expectedSha256,
          download: typeof ctx.download === 'function'
            ? async (url) => {
                const ws = ctx.workspaceRoot ?? ctx.cwd;
                const res = await ctx.download!(url, join(ws, 'downloads'));
                if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
                return { filePath: res.value.filePath, bytes: res.value.bytes };
              }
            : undefined,
          enable: async (dir) => {
            const result = await service.enable(dir, context, AbortSignal.timeout(60_000));
            return result.ok ? { ok: true } : { ok: false, detail: `${result.error.code}: ${result.error.message}` };
          },
        });
        if (!r.ok) return `[${r.code}] ${r.message}`;
        return [
          `插件已安装：${r.name} v${r.version}（工具 ${r.toolCount} 个；sha256=${r.sourceSha256 ?? 'N/A'}${r.sha256Verified ? ' ✅ 已校验' : ' ⚠ 未校验'}）`,
          r.enabled ? '  已启用（沙箱门/owned scope 由 lifecycle 承担）' : `  未自动启用——/plugin enable ${r.name}`,
          r.note ? `  ${r.note}` : null,
        ].filter(Boolean).join('\n');
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
    const { parsePluginManifest, setPluginEnabled } = await import('../kernel/plugins.js');
    const [sub, ...rest] = args;
    const all = ctx.getPlugins?.() ?? [];

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

    // /plugin reload ——由组合根 owner 原子同步 Agent 工具、CommandBus 与 NL 三张表。
    if (sub === 'reload') {
      if (!ctx.reloadPlugins) return '当前环境未装配插件 runtime，无法热重载';
      const reloaded = await ctx.reloadPlugins();
      if (!reloaded.ok) return reloaded.message;
      const enabled = reloaded.plugins.filter(p => p.manifest.enabled !== false).length;
      return `插件已热重载：${enabled} 个启用（${reloaded.toolCount} 工具 + ${reloaded.commandCount} 命令）${reloaded.cleanupFailures ? `；${reloaded.cleanupFailures} 个旧插件清理失败` : ''}`;
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

    if (sub === 'install') {
      if (!ctx.reloadPlugins) return '当前环境未装配插件 runtime，无法安装';
      const src = resolve(process.cwd(), name);
      if (!existsSync(src)) return `目录不存在：${src}`;
      const manifestFile = join(src, 'plugin.json');
      if (!existsSync(manifestFile)) return `不是插件目录（缺 plugin.json）：${src}`;
      // 解析清单取插件名（复制目标目录名）
      let pluginName = '';
      try { pluginName = parsePluginManifest(readFileSync(manifestFile, 'utf8')).name; } catch (e: any) { return `plugin.json 解析失败：${e?.message?.slice(0, 120) ?? e}`; }
      const dest = join(ctx.dataDir, 'plugins', pluginName);
      if (existsSync(dest)) return `插件已存在：${pluginName}（/plugin remove ${pluginName} 后重装）`;
      mkdirSync(dest, { recursive: true });
      // 复制 plugin.json 与 index.js（及 data 目录）
      for (const f of ['plugin.json', 'index.js']) {
        const srcF = join(src, f);
        if (existsSync(srcF)) writeFileSync(join(dest, f), readFileSync(srcF)); // V4 P1-11：Buffer 直拷——utf8 字符串往返损坏二进制插件资产
      }
      const srcData = join(src, 'data');
      if (existsSync(srcData)) {
        mkdirSync(join(dest, 'data'), { recursive: true });
        for (const f of readdirSync(srcData)) {
          writeFileSync(join(dest, 'data', f), readFileSync(join(srcData, f))); // V4 P1-11：同上
        }
      }
      const reloaded = await ctx.reloadPlugins();
      if (!reloaded.ok) {
        rmSync(dest, { recursive: true, force: true });
        await ctx.reloadPlugins();
        return `插件安装回滚：${reloaded.message}`;
      }
      return `插件已安装并热生效：${pluginName} → ${dest}（/plugin list 查看）`;
    }

    const target = all.find(p => p.manifest.name === name);
    if (!target) return `插件不存在：${name}（/plugin list 查看）`;

    if (sub === 'remove') {
      if (!ctx.reloadPlugins) return '当前环境未装配插件 runtime，无法移除';
      // 暂存到扫描根外的同卷目录：rename 保持原子，候选 load 不会重新发现待移除插件。
      const stagingRoot = join(ctx.dataDir, 'plugin-removals');
      const staging = join(stagingRoot, `${basename(target.dir)}-${Date.now().toString(36)}`);
      try {
        mkdirSync(stagingRoot, { recursive: true });
        renameSync(target.dir, staging);
      } catch (e: any) { return `删除失败：${e?.message?.slice(0, 120) ?? e}`; }
      const reloaded = await ctx.reloadPlugins();
      if (!reloaded.ok) {
        try { renameSync(staging, target.dir); } catch (e: any) { return `插件移除失败且目录恢复失败：${e?.message?.slice(0, 120) ?? e}`; }
        await ctx.reloadPlugins();
        return `插件移除回滚：${reloaded.message}`;
      }
      try { rmSync(staging, { recursive: true, force: true }); } catch (e: any) { return `插件已从 runtime 移除，但暂存目录清理失败：${e?.message?.slice(0, 120) ?? e}`; }
      return `插件已移除：${name}`;
    }
    if (sub === 'enable' || sub === 'disable') {
      if (!ctx.reloadPlugins) return '当前环境未装配插件 runtime，无法修改状态';
      const manifestFile = join(target.dir, 'plugin.json');
      const previousManifest = readFileSync(manifestFile, 'utf8');
      const ok = setPluginEnabled(target.dir, sub === 'enable');
      if (!ok) return `状态修改失败：${name}`;
      const reloaded = await ctx.reloadPlugins();
      if (!reloaded.ok) {
        writeFileSync(manifestFile, previousManifest, 'utf8');
        await ctx.reloadPlugins();
        return `插件状态修改回滚：${reloaded.message}`;
      }
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
      if (sub === 'connect' && rest[0]) {
        const target = entries.find(e => e.name === rest[0]);
        if (target?.source === 'project') {
          const { isProjectMcpTrusted } = await import('../kernel/mcp.js');
          if (!isProjectMcpTrusted(ctx.dataDir, ctx.cwd, target)) return `项目 MCP server「${target.name}」未信任；请先执行 /mcp trust ${target.name}`;
        }
      }
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
    const { loadMcpConfig, loadProjectMcpConfig, loadUserMcpConfig, saveMcpConfig, saveProjectMcpConfig, connectMcp, trustProjectMcpServer } = await import('../kernel/mcp.js');
    const [sub, ...rest] = args;
    const entries = loadMcpConfig(ctx.dataDir, { cwd: ctx.cwd });
    if (sub === 'trust') {
      const name = rest[0];
      const target = entries.find(entry => entry.name === name && entry.source === 'project');
      if (!target) return `未找到项目级 MCP server「${name ?? ''}」`;
      trustProjectMcpServer(ctx.dataDir, ctx.cwd, target);
      try { await ctx.reloadMcp?.(); } catch { /* trust persisted even if candidate is unavailable */ }
      return `已信任项目 MCP server「${name}」；批准账本保存在 host data，配置变更后需重新信任`;
    }
    const tag = (s: { source: string }) => (s.source === 'project' ? ' [项目]' : ' [用户]');
    if (!sub || sub === 'list') {
      if (!entries.length) {
        return lines(' MCP ', [' 未配置 server', '', ' 用法：/mcp add <名称> <命令> [参数...]（--project 写项目 .mcp.json）', '       /mcp remove <名称>', '       /mcp test <名称>', ' 配置：项目 .mcp.json（mcpServers 格式）+ 用户 data/mcp.json', ' 项目 MCP 默认不启动；/mcp trust <名称> 显式批准（配置变化后失效）', ' strictMcpConfig=true 时仅信任项目声明（--strict-mcp-config 等价）']);
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
        const project = loadProjectMcpConfig(ctx.cwd);
        saveProjectMcpConfig(ctx.cwd, [...project, server]);
      } else {
        const user = loadUserMcpConfig(ctx.dataDir);
        saveMcpConfig(ctx.dataDir, [...user, server]);
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
        const project = loadProjectMcpConfig(ctx.cwd);
        saveProjectMcpConfig(ctx.cwd, [...project, server]);
      } else {
        const user = loadUserMcpConfig(ctx.dataDir);
        saveMcpConfig(ctx.dataDir, [...user, server]);
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
      const project = loadProjectMcpConfig(ctx.cwd);
      const user = loadUserMcpConfig(ctx.dataDir);
      const removedProject = project.some(s => s.name === name);
      const removedUser = user.some(s => s.name === name);
      if (!removedProject && !removedUser) return `未找到 server「${name}」`;
      // 仅当原本存在项目级配置时才回写——避免在无 .mcp.json 的项目根凭空创建空文件
      if (project.length > 0) {
        saveProjectMcpConfig(ctx.cwd, project.filter(s => s.name !== name));
      }
      saveMcpConfig(ctx.dataDir, user.filter(s => s.name !== name));
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

  // /perm budget：工具执行预算查看/重置（V4 P0-3——预算按日换代自动重计，本命令提供
  // 即时余量可见性与手动清零出口；limits 是并发护栏语义而非终身配额）
  bus.register('/perm budget', (args) => {
    const [sub] = args;
    const row = ctx.db.prepare(`SELECT id, limits_json, used_json FROM budget_snapshots WHERE active=1`).get() as
      | { id: string; limits_json: string; used_json: string }
      | undefined;
    if (!row) return '预算快照不存在（安全子系统未初始化）';
    const limits = JSON.parse(row.limits_json) as Record<string, number>;
    const used = JSON.parse(row.used_json) as Record<string, number>;
    const fmt = () => Object.keys(limits).sort().map(k => {
      const u = used[k] ?? 0;
      const left = Math.max(0, limits[k] - u);
      return ` ${k.padEnd(16)} 已用 ${String(u).padStart(4)} / ${limits[k]}（剩 ${left}）`;
    });
    if (sub === 'reset') {
      ctx.db.prepare(`UPDATE budget_snapshots SET used_json='{}' WHERE id=?`).run(row.id);
      return `已清零预算用量（${row.id}）——全部工具类额度恢复上限`;
    }
    if (sub && sub !== 'status') {
      return '用法：/perm budget status ｜ reset';
    }
    return lines(` 预算 ${row.id} `, fmt());
  });

  // /self-evolve：自举模式（颠覆性改造——WxNodus 改进自己）
  // 闭环：AI 分析自身源码 → 生成补丁（JSON）→ 真实应用（undo shadow 备份可回滚）
  //   → 跑自身测试套件 → 失败自动回滚 → 报告（绝不自动提交——用户确认）
  bus.register('/self-evolve', async (args, _raw, execution) => {
    // --report：自我审查报告模式（只审查不修改——AI 审查源码输出建议清单落盘，
    //   绝不应用补丁；与默认自举模式互补：先报告后决定是否动手）
    const first = args[0];
    if (first === '--report' || first === 'report') {
      const { resolveApiKey } = await import('../kernel/providers.js');
      const keyRes = resolveApiKey(ctx.config.get('settings') as any);
      if (!keyRes.key) return commandCompletion('自我审查需要模型密钥——/model set-key <密钥> 后可用（AI 审查自身源码输出建议）', 'blocked');
      if (!ctx.agent) return commandCompletion('当前环境无 agent（无法审查）', 'blocked');
      const scope = args.slice(1).join(' ') || 'src/kernel、src/commands、src/cli';
      const r = await ctx.agent.run(`你是 WxNodus 的自我审查引擎。审查自身源码，输出改进建议清单（只审查，绝不修改任何文件）。
审查范围：${scope}
要求：
- 用 fs_read 抽查关键文件（kernel/agent.ts、commands/handlers.ts、commands/handlersExt.ts、kernel/env.ts、kernel/permissions.ts 等）后给出结论
- 输出必须是 JSON 数组：[{"file":"相对路径","severity":"high|medium|low","issue":"问题描述","suggestion":"具体改进建议"}]
- 聚焦：真实 bug、重复代码、安全隐患、死代码、接口漂移；不列风格问题
- 至少 5 条，最多 15 条；只输出 JSON，不要任何其他文字`, { signal: execution.signal });
      const runStatus = normalizeAgentRunStatus(r);
      if (runStatus !== 'succeeded') {
        return commandCompletion(`自我审查未完成：${r.text.slice(0, 300)}`, runStatus);
      }
      const text = r.text.trim();
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) return commandCompletion(`模型未输出审查 JSON：${text.slice(0, 150)}`, 'failed');
      let items: Array<{ file?: string; severity?: string; issue?: string; suggestion?: string }>;
      try { items = JSON.parse(m[0]); } catch { return commandCompletion('审查结果解析失败（模型输出非法 JSON）——重试', 'failed'); }
      if (!Array.isArray(items) || !items.length) return commandCompletion('审查为空——重试', 'inconclusive');
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
    if (!keyRes.key) return commandCompletion('自举需要模型密钥——/model set-key <密钥> 后可用（AI 分析自身源码生成补丁并自验证）', 'blocked');
    if (!ctx.agent) return commandCompletion('当前环境无 agent（无法自举）', 'blocked');
    // 2. 生成补丁（限定 src/kernel + src/commands——不碰装配/UI/测试，防止自毁）
    const r = await ctx.agent.run(`你是 WxNodus 的自我改进引擎。分析自身源码并生成修改补丁。
改进方向：${direction}
约束：
- 只修改 src/kernel/** 与 src/commands/**（绝不碰 src/cli、src/wxnodus-ui、tests、package.json）
- 输出必须是 JSON 数组：[{"file":"相对路径","old":"被替换原文（必须与现有代码精确匹配）","new":"替换后内容"}]
- 每个补丁 ≤ 30 行；小而明确的改进；不重写整文件
- 动手前用 fs_read 读文件确认 old 精确匹配
- 只输出 JSON，不要任何其他文字`, { signal: execution.signal });
    const runStatus = normalizeAgentRunStatus(r);
    if (runStatus !== 'succeeded') {
      return commandCompletion(`自举分析未完成：${r.text.slice(0, 300)}`, runStatus);
    }
    const text = r.text.trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return commandCompletion(`模型未输出补丁 JSON：${text.slice(0, 150)}`, 'failed');
    let patches: Array<{ file?: string; old?: string; new?: string }>;
    try { patches = JSON.parse(m[0]); } catch { return commandCompletion('补丁解析失败（模型输出非法 JSON）——换更小方向重试', 'failed'); }
    if (!Array.isArray(patches) || !patches.length) return commandCompletion('补丁为空——换方向重试', 'inconclusive');
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
    if (!okCount) return commandCompletion('全部补丁未应用（old 未匹配）——模型幻觉或文件已变更，重试', 'incomplete');
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
      return commandCompletion(lines(' 自举失败——已自动回滚 ', [
        ` 方向：${direction}`,
        ` 补丁：${okCount}/${applied.length} 应用成功`,
        ` 测试：${testOut}`,
        ` 已回滚：${rolled} 个文件（补丁全部撤销）`,
        ` 建议：换更小粒度的方向重试，或人工检查后手工修改`,
      ]), 'failed');
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
  bus.register('/claw', async (args, _raw, execution) => {
    const url = args.join(' ').replace(/^["']|["']$/g, '').trim();
    if (!url) return '用法：/claw <URL>（网页抓取，SSRF 防护拦截内网；JS 页自动浏览器兜底）';
    try {
      const { safeFetchText } = await import('../kernel/ssrf.js');
      const { htmlToText, extractMainText } = await import('../kernel/html.js');
      // A20：消费 settings.proxy（原死配置接入）+ 响应体上限 1MB + 默认 UA
      const proxy = (ctx.config.get('settings') as any)?.proxy as string | undefined;
      const r = await safeFetchText(url, { maxBytes: 1_000_000, proxy, signal: execution.signal });
      if ('error' in r) return r.error;
      // 审查接线（自动化护栏）：robots.txt 禁止路径拦截 + 验证码页面提示
      const { robotsGuard } = await import('../kernel/robotsGuard.js');
      const guard = await robotsGuard(url, r.text, execution.signal);
      if (execution.signal?.aborted) return '请求已取消';
      if (guard.block) return guard.block;
      // 状态码归因：4xx/5xx 页面正文（如 404 Not Found）不当作有效内容
      if (r.status >= 400) return `抓取失败：HTTP ${r.status}（${url}）——页面不可用或反爬拦截`;
      const html = r.text;
      // 正文提取（readability 式启发优先——导航/页脚/广告噪声不入结果；空则全量剥标签兜底）
      let text = extractMainText(html);
      if (!text) text = htmlToText(html);
      // JS 渲染兜底：静态抓取几乎无正文（<200 字符）→ 走真实浏览器渲染拿正文
      if ((!text || text.length < 200) && /^https?:\/\//i.test(url) && !execution.signal?.aborted) {
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
  bus.register('/web', async (args, _raw, execution) => {
    const url = args.join(' ').trim();
    if (!url) return '用法：/web <URL>';
    if (!ctx.commandBus) return '命令总线不可用';

    const r = await ctx.commandBus.execute(`/claw ${url}`, execution);

    return r.output ?? (r.ok ? '' : '抓取失败');
  });

  // /gateway：本地 HTTP JSON-RPC 网关（localhost 监听，POST /rpc 面）
  //   method: prompt {text} → 意图路由执行；command {input} → 命令总线
  let gatewayServer: import('node:http').Server | null = null;
  const gatewayExecutions = new Set<{ cancel(): void }>();
  const cancelGatewayExecutions = (): void => {
    for (const execution of [...gatewayExecutions]) execution.cancel();
  };
  const closeGateway = async (): Promise<void> => {
    cancelGatewayExecutions();
    if (!gatewayServer) return;
    const server = gatewayServer;
    gatewayServer = null;
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  ctx.registerDisposer?.('legacy-gateway', closeGateway);
  bus.register('/gateway', async (args) => {
    const [sub, ...rest] = args;
    const port = parseInt(rest[0] ?? '8765', 10);
    if (sub === 'start' || !sub) {
      if (gatewayServer) return `网关已在运行：http://127.0.0.1:${(gatewayServer.address() as any)?.port ?? port}`;
      const { createServer } = await import('node:http');
      const { randomBytes, timingSafeEqual } = await import('node:crypto');
      // V4 P0-7：Bearer 认证——此前 /rpc 零认证：CORS simple request（text/plain 无需预检）可
      // 从任意浏览器恶意页面跨站驱动 command/prompt（含 /perm yolo 类提权）。OpenCode 同型
      // 缺陷已酿 CVE-2026-22812。token：WXNODUS_GATEWAY_TOKEN 可固定（脚本集成），否则随机。
      const gatewayToken = process.env.WXNODUS_GATEWAY_TOKEN || randomBytes(24).toString('hex');
      const bearerOk = (req: import('node:http').IncomingMessage): boolean => {
        const auth = String(req.headers.authorization ?? '');
        if (!auth.startsWith('Bearer ')) return false;
        const given = Buffer.from(auth.slice(7));
        const want = Buffer.from(gatewayToken);
        return given.length === want.length && timingSafeEqual(given, want);
      };
      gatewayServer = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST' || req.url !== '/rpc') {
          res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        // 认证门先于 body 读取：Content-Type 必须 application/json（封死 simple request 跨站路径）+ Bearer
        if (String(req.headers['content-type'] ?? '').toLowerCase().indexOf('application/json') < 0) {
          res.writeHead(415); res.end(JSON.stringify({ error: 'content-type must be application/json' })); return;
        }
        if (!bearerOk(req)) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'missing or invalid bearer token' })); return;
        }
        // V4 P1-4：Buffer 聚合整体解码（多字节序列跨分包安全——同 serve.ts readBody 修法）
        const bodyChunks: Buffer[] = [];
        let bodyBytes = 0;
        req.on('data', (c: Buffer) => { bodyChunks.push(c); bodyBytes += c.length; if (bodyBytes > 1e6) req.destroy(); });
        req.on('end', () => {
          const body = Buffer.concat(bodyChunks).toString('utf8');
          void (async () => {
            try {
              const { method, params } = JSON.parse(body || '{}');
              const sessionId = String(params?.session_id ?? ctx.agent?.getSessionId?.() ?? 'default');
              if (method === 'command') {
                if (!ctx.runInvocation) { res.writeHead(503); res.end(JSON.stringify({ error: 'run admission unavailable' })); return; }
                const handle = ctx.runInvocation.invoke({
                  kind: 'command',
                  command: String(params?.input ?? ''),
                  sessionId,
                });
                const cancel = () => { if (!res.writableEnded) handle.cancel(); };
                gatewayExecutions.add(handle);
                req.once('aborted', cancel);
                res.once('close', cancel);
                try {
                  const run = await handle.completion;
                  if (res.destroyed || res.writableEnded) return;
                  const r = run.value;
                  res.writeHead(httpStatusForCompletion(run.status)); res.end(JSON.stringify({
                    ok: run.status === 'succeeded',
                    status: run.status,
                    run_id: handle.context.runId,
                    output: r?.output || r?.dispatch?.message || run.error || r?.error || '',
                  }));
                } finally {
                  req.off('aborted', cancel);
                  res.off('close', cancel);
                  gatewayExecutions.delete(handle);
                }
              } else if (method === 'prompt') {
                if (!ctx.runInvocation) { res.writeHead(503); res.end(JSON.stringify({ error: 'run admission unavailable' })); return; }
                const handle = ctx.runInvocation.invoke({
                  kind: 'agent',
                  prompt: String(params?.text ?? ''),
                  sessionId,
                });
                const cancel = () => { if (!res.writableEnded) handle.cancel(); };
                gatewayExecutions.add(handle);
                req.once('aborted', cancel);
                res.once('close', cancel);
                try {
                  const run = await handle.completion;
                  if (res.destroyed || res.writableEnded) return;
                  const r = run.value;
                  res.writeHead(httpStatusForCompletion(run.status)); res.end(JSON.stringify({
                    ok: run.status === 'succeeded',
                    status: run.status,
                    run_id: handle.context.runId,
                    text: r?.text ?? '',
                    turns: r?.turns ?? 0,
                    ...(run.error ? { error: run.error } : {}),
                  }));
                } finally {
                  req.off('aborted', cancel);
                  res.off('close', cancel);
                  gatewayExecutions.delete(handle);
                }
              } else if (method === 'health') {
                res.writeHead(200); res.end(JSON.stringify({ ok: true, version: WXNODUS_VERSION }));
              } else {
                res.writeHead(400); res.end(JSON.stringify({ error: `unknown method: ${method}` }));
              }
            } catch (e: any) {
              if (!res.destroyed && !res.writableEnded) {
                res.writeHead(500); res.end(JSON.stringify({ error: String(e?.message ?? e) }));
              }
            }
          })();
        });
      });
      await new Promise<void>((resolve, reject) => {
        gatewayServer!.once('error', reject);
        gatewayServer!.listen(port, '127.0.0.1', resolve);
      }).catch(() => { gatewayServer = null; return; });
      if (!gatewayServer) return `启动失败：端口 ${port} 可能被占用（/gateway start <其他端口>）`;
      const activePort = (gatewayServer.address() as import('node:net').AddressInfo).port;
      return `__KEEPALIVE__\n网关已启动：http://127.0.0.1:${activePort}（POST /rpc，method=command|prompt|health；仅本机监听，SIGINT 停止）\n访问令牌（Bearer，仅此一次展示；WXNODUS_GATEWAY_TOKEN 可固定）：${gatewayToken}`;
    }
    if (sub === 'stop') {
      if (!gatewayServer) return '网关未运行';
      await closeGateway();
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
  let a2aServer: { url: string; token: string; stop(): Promise<void> } | null = null;
  const closeA2a = async (): Promise<void> => {
    const server = a2aServer;
    a2aServer = null;
    await server?.stop();
  };
  ctx.registerDisposer?.('a2a-server', closeA2a);
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
      if (!ctx.runInvocation) return 'a2a serve 不可用：当前环境未提供 Run 接纳端口';
      const { a2aServe } = await import('../kernel/a2a.js');
      const { discoverSkills } = await import('../kernel/skills.js');
      try {
        a2aServer = await a2aServe(port, (text, request) => {
          const handle = ctx.runInvocation!.invoke({
            kind: 'agent',
            prompt: text,
            sessionId: request.sessionId,
          });
          return {
            cancel: () => handle.cancel(),
            completion: handle.completion.then(run => ({
              ok: run.status === 'succeeded',
              status: run.status,
              text: run.value?.text ?? '',
              error: run.error,
            })),
          };
        }, {
          // 完整版：agent card 携带真实技能声明（对端可发现本机能力面）
          card: {
            name: 'wxnodus',
            description: 'Windows 本地 AI 编码 CLI（数据不出机）',
            skills: discoverSkills(ctx.dataDir, ctx.cwd).slice(0, 50).map(s => ({ name: s.name, description: s.description })),
          },
        });
        return `__KEEPALIVE__\nA2A 端点已启动：${a2aServer.url}（messages/send 快捷通道 + tasks/* 任务流 + /.well-known/agent.json 卡片，仅本机监听，SIGINT 停止；/a2a stop 停止）\n访问令牌（Authorization: Bearer，仅此一次展示）：${a2aServer.token}`;
      } catch (e: any) {
        return `启动失败：端口 ${port} 可能被占用（/a2a serve <其他端口>）——${e?.message?.slice(0, 80)}`;
      }
    }
    if (sub === 'stop') {
      if (!a2aServer) return 'A2A 端点未运行';
      await closeA2a();
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
    return 'ACP stdio 服务只支持专用 headless 入口：wxnodus -p "/acp server"';
  });

  // ── 协作类 ──────────────────────────────────
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
    const { resolveApiKey, MODEL_CATALOG } = await import('../kernel/providers.js');
    const { resolveDefaultModel } = await import('../kernel/defaults.js');
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
  bus.register('/delegate', async (args, _raw, execution) => {
    // W3 Subagent 第 1 步：组合路由决策——modern/required 在 live process host 接线完成前 fail-closed
    const { decideSubagentRoute } = await import('./extensionRouting.js');
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
        const { findAgentDef } = await import('../kernel/agents.js');
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
          const { verifyProject } = await import('../build/verify.js');
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
      const { parseExternalSessionJsonl } = await import('../kernel/sessionImport.js');
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

  // 审计留痕（审查修复：计数动态化——此前硬编码 48 与实际注册数不符）
  try {
    const registered = (ctx.commandBus as any)?.list?.().length ?? 'n/a';
    appendAudit(ctx.db, 'handlers.ext.registered', { count: registered });
  } catch { /* 审计表未就绪时静默 */ }
}
