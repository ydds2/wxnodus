// src/commands/handlersExt.ts — 扩展命令处理器（此文件条数与 SLASH 长度动态同步——计数勿回写任何具体数字，防漂移）
// 设计：与 handlers.ts 分离，按类补齐——工具（确定性）/会话/记忆/构建/安全/
//       系统/视觉/连接/协作。每个命令真实可用（查询现有数据或执行确定性操作），
//       输出统一 lines()（标题+缩进条目，纯文本）或单行。红线：只读工具不写库；路径操作限制在 dataDir。
// 2026-08-19 输出格式体系（docs/output-format-spec-2026.md）：命令输出 = 标题行
// + 两格缩进条目（纯文本、无边框——与 handlers.ts 同构）
import { lines } from './outputFormat.js';
import { basename, join, resolve, relative, normalize, sep } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { appendAudit } from '../store/db.js';
import { loadPermRules, savePermRules } from '../kernel/permissions.js';
import { labelTruncate } from '../kernel/truncate.js';
import type { HandlerCtx } from './handlers.js';
import { registerDeterministicTools } from './ext/deterministicTools.js';
import { commandCompletion, type CommandBus } from '../app/CommandBus.js';
import { normalizeAgentRunStatus } from '../protocol/runs.js';
import { registerSessionCommands } from './ext/sessionCommands.js';
import { registerWebCommands } from './ext/webCommands.js';
import { registerAgentFlowCommands } from './ext/agentFlowCommands.js';
import { registerOasisCommands } from './ext/oasisCommands.js';
import { registerPanelCommands } from './ext/panelCommands.js';
import { registerWatchCommands } from './ext/watchCommands.js';
import { registerModpackCommands } from './ext/modpackCommands.js';

// 嵌套 Agent 终态契约（NestedAgentResult/nestedCompletion/aggregateNestedStatuses）已随第 5 块迁至
// ext/agentFlowCommands.ts——如需跨块复用再提为 protocol 层（YAGNI）
import { registerProfileMemoryBuildCommands } from './ext/profileMemoryBuildCommands.js';
// renderWaterfall/parseProfileAddArgs/parseBalanceSetArgs 已迁至 ext 模块（拆分第 2/3 块 audit §13.46）——re-export 保持导入兼容
export { renderWaterfall } from './ext/sessionCommands.js';
export { parseProfileAddArgs, parseBalanceSetArgs } from './ext/profileMemoryBuildCommands.js';

// fsLsRows/fsReadRows/sqlTableRows 已迁至 ext/deterministicTools.ts（巨文件拆分 audit §13.43）——re-export 保持测试导入兼容
export { fsLsRows, fsReadRows, sqlTableRows } from './ext/deterministicTools.js';


// 安全表达式求值（仅数字/四则/括号/空格）
export function registerExtHandlers(bus: CommandBus, ctx: HandlerCtx): void {
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
    // ⅩⅩⅨ（专项审计）：急停生产触发器——顶部拦截（不依赖路由决策/截图可用）。
    // 此前 EmergencyStopService 存在且有管线检查点，但生产上没有任何东西能按下急停。
    if (args[0] === 'estop' || args[0] === 'estop-status') {
      const { getEmergencyStopService } = await import('../application/computer/emergencyStopService.js');
      const emergency = getEmergencyStopService(); // 进程级单例——跨调用持续
      if (args[0] === 'estop') {
        emergency.stop();
        return `⛔ Computer Use 已急停：新动作一律拒绝（COMPUTER_EMERGENCY_STOP_ACTIVE）。复位需全新作用域高影响审批 grant（代码侧 reset(grant) 唯一通道——命令面不提供 resume，防误触绕过）`;
      }
      return emergency.active ? '⛔ 急停激活中——computer 动作全拒绝' : '✓ 急停未激活';
    }
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
      const { getEmergencyStopService } = await import('../application/computer/emergencyStopService.js');
      const { captureScreen } = await import('../kernel/computer/index.js');
      const { ActionGuard } = await import('../kernel/computer/guards.js');
      const { createKernelComputerUse } = await import('./computerCompat.js');
      const { isHighImpactKind } = await import('../domain/computer/computerAction.js');
      const shot0 = await captureScreen();
      if (!shot0) return 'Computer Use 不可用：原生模块缺失或无图形环境（CI/远程会话）';
      const kernelCu = await createKernelComputerUse(new ActionGuard({ width: shot0.width, height: shot0.height }));
      // ⅩⅩⅨ：进程级单例（/computer estop 按停后跨调用持续——见 emergencyStopService.ts）
      const emergency = getEmergencyStopService();
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
    // ⅩⅩⅩⅣ：物理像素直通（C-1 修复）
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
      const lx = Math.round(x);
    const ly = Math.round(y);
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
    const { renderMarkdownText } = await import('../lib/markdown/renderText.js');
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
        // B3（2026-09-04）：在线状态 + 内存列（与 legacy 路由共用单一事实源渲染器）
        const { renderMcpList } = await import('./mcpStatus.js');
        return await renderMcpList(entries, ctx.getMcpClients?.() ?? [], (ctx.config.get('settings') ?? {}) as Record<string, any>, { dataDir: ctx.dataDir, cwd: ctx.cwd });
      }
      if (sub === 'status') {
        const { renderMcpStatus } = await import('./mcpStatus.js');
        return await renderMcpStatus(entries, ctx.getMcpClients?.() ?? [], (ctx.config.get('settings') ?? {}) as Record<string, any>, { dataDir: ctx.dataDir, cwd: ctx.cwd }, rest[0]);
      }
      if (sub === 'idle') {
        const { renderMcpIdleState, applyMcpIdleCommand } = await import('./mcpStatus.js');
        if (!rest.length) return renderMcpIdleState((ctx.config.get('settings') ?? {}) as Record<string, any>);
        return applyMcpIdleCommand(rest, ctx);
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
      return 'modern 路由：/mcp list｜status [名称]｜idle [on 秒|off]｜connect <名称>（incoming server 经 WxNodusMcpServer——未接线 pipeline 的 surface 如实 NOT_DELIVERED）';
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
      // B3（2026-09-04）：在线状态 + 内存列（组合根真实连接 + 进程枚举真实工作集——单一事实源模块）
      const { renderMcpList } = await import('./mcpStatus.js');
      return await renderMcpList(entries, ctx.getMcpClients?.() ?? [], (ctx.config.get('settings') ?? {}) as Record<string, any>, { dataDir: ctx.dataDir, cwd: ctx.cwd });
    }
    if (sub === 'status') {
      const { renderMcpStatus } = await import('./mcpStatus.js');
      return await renderMcpStatus(entries, ctx.getMcpClients?.() ?? [], (ctx.config.get('settings') ?? {}) as Record<string, any>, { dataDir: ctx.dataDir, cwd: ctx.cwd }, rest[0]);
    }
    if (sub === 'idle') {
      const { renderMcpIdleState, applyMcpIdleCommand } = await import('./mcpStatus.js');
      if (!rest.length) return renderMcpIdleState((ctx.config.get('settings') ?? {}) as Record<string, any>);
      return applyMcpIdleCommand(rest, ctx);
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
    return '用法：/mcp list｜status [名称]｜idle [on <秒数 30–3600>|off]｜add [--project] <名称> <命令> [参数...]｜add-http [--project] <名称> <URL>｜remove <名称>｜test <名称>';
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

  // —— 网络/浏览器/网关/协议接入类已迁至 ext/webCommands.ts（拆分第 4 块 C-6）——
  registerWebCommands(bus, ctx);
  // —— 子代理/编排/高阶流类已迁至 ext/agentFlowCommands.ts（拆分第 5 块 C-6）——
  registerAgentFlowCommands(bus, ctx);
  // —— OASIS 统一运行时门户（2026-09-03）：全栈异构组件注册表/拓扑（docs/oasis-integration-assessment）——
  registerOasisCommands(bus, ctx);
  registerPanelCommands(bus, ctx);
  // —— 常驻屏幕视频流（2026-09-03 · P0）：/watch 实时捕捉/场景分段/回放证据（docs/screenwatch-localvlm-modpack-plan）——
  registerWatchCommands(bus, ctx);
  // —— Mod 整合包（2026-09-03 · P3b）：/modpack 清单/兼容矩阵/一键安装/导出（我的世界 modpack 语义）——
  registerModpackCommands(bus, ctx);

  // 审计留痕（审查修复：计数动态化——此前硬编码 48 与实际注册数不符）
  try {
    const registered = (ctx.commandBus as any)?.list?.().length ?? 'n/a';
    appendAudit(ctx.db, 'handlers.ext.registered', { count: registered });
  } catch { /* 审计表未就绪时静默 */ }
}
