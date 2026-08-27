// src/presentation/tui/interactiveLoop.ts — 薄层 TUI 交互循环（kimi code 风格化，2026-08-28）
// 设计（机制参考 crush/codex REPL 语义 + kimi code UI 风格·实现原创；V4 决策「薄投影层，绝不引 Ink」）：
//   · 单一 readline 实例 + 模式状态机（prompt / approval / clarify / secret / form）——
//     审批/澄清/密码复用 wire 网关协议（headlessGateway 的 onRequest 广播 + *.respond 应答），
//     与 --wire 前端同一套 RPC 契约，绝无第二套审批通道；
//   · 每轮 agent 运行：runInvocation.invoke（与 -p/--wire 同一接纳面）→ bus 事件过滤 runId
//     → ansiRenderer 纯函数渲染（语义色由结构化事件决定，零正则猜测）；
//   · kimi 风格化（2026-08-28，参考锚点见 kimi-gap-alignment-ledger.md）：
//     ① TTY 下「Thinking」折叠动画（0.13s×6 点帧 + 耗时 + token 估算 + tok/s 心跳），
//        收口落灰色斜体 "Thought for Xs · N tokens"——思考原文永不直出；
//     ② 生成中 "Composing..." spinner 行 + Markdown 增量提交（完整块立即落盘、围栏闭合才提交）；
//     ③ 工具行 "Using X (关键参数)" → 完成 "Used" + 绿/红 bullet 结果行；
//     ④ 通知按 severity 着色（标题加粗 + 灰正文 2 行预览）；
//     ⑤ 底栏（─ 分隔线 + 模式(model ●/○) + cwd 分支徽标 + 30s 轮换提示，窄终端降级）；
//     ⑥ Ctrl+C 中断当前回合（handle.cancel，wire 同链路）；
//     非 TTY 诚实降级：零动画、纯文本流（管道/测试环境零 ANSI 乱码）。
//   · fail-closed：应答超时由网关层兜底（deny/''/null），TUI 层 pending 镜像定时器同步复位。
import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { gitBranch } from './gitStatus.js';
import { MarkdownStreamer } from './markdownStreamer.js';
import { extractKeyArgument } from './keyArg.js';
import { estimateTokens, thinkBulletFrameAt, spinnerFrameAt } from './theme.js';
import * as R from './ansiRenderer.js';

export interface InteractiveLoopDeps {
  sessionId: string;
  modelLabel: string;
  gateway: {
    request(method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
    requestApproval(name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'>;
  };
  bus: { on(type: string, handler: (e: any) => void): () => void };
  runInvocation: {
    invoke(input: { kind: 'agent' | 'command'; prompt?: string; command?: string; runId?: string; correlationId?: string; sessionId?: string }): {
      completion: Promise<{ status: string; value?: { ok?: boolean; text?: string; turns?: number; interrupted?: boolean }; error?: unknown }>;
      cancel(): void;
    };
  };
  commandBus: { execute(input: string, ctx?: unknown): Promise<unknown> };
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** 底栏工作目录（缺省 process.cwd()） */
  cwd?: string;
  /** 非 slash 输入的命令意图路由（-p 同链路；kind 非 command/tool 一律按 agent 回合处理） */
  routeInput?: (text: string) => Promise<{ kind: 'command' | 'agent' | 'tool' | 'chat'; cmd?: string; value?: string }>;
  /** 应答广播挂载点：组合根在创建网关时经中转器注入（网关构造早于循环） */
  setOnRequest?: (handler: (ev: { type: string } & Record<string, unknown>) => void) => void;
  timeoutMs?: number;
  onExit?: () => void;
}

type Mode = 'prompt' | 'approval' | 'clarify' | 'secret' | 'form';
interface PendingRequest {
  mode: Exclude<Mode, 'prompt'>;
  requestId: string;
  label: string;
  timer: ReturnType<typeof setTimeout>;
}

const mapApprovalAnswer = (line: string): 'allow' | 'session' | 'deny' => {
  const a = line.trim().toLowerCase();
  if (a === 'y' || a === 'yes' || a === 'allow' || a === '是') return 'allow';
  if (a === 's' || a === 'session' || a === '本次') return 'session';
  return 'deny';
};

/** 底栏轮换提示（kimi _build_toolbar_tips 语义——30s 轮换，仅 TTY 显示） */
const TIPS = [
  '/help 查看全部命令 · /model set-key 配置模型',
  'Ctrl+C 中断当前回合 · /exit 退出',
  '/memory 长期记忆 · /jobs 后台任务',
  '/audit export 审计导出（数据不出机）',
];
const TIP_INTERVAL_MS = 30_000;

const REDRAW = '\r\x1b[2K'; // 单行重绘（薄层行式投影的动画载体——无替代屏/Live 引擎）

export async function startInteractiveLoop(deps: InteractiveLoopDeps): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const tty = stdout.isTTY === true && stdin.isTTY === true;
  const colors = stdout.isTTY === true;
  const opts = { colors };
  const cwd = deps.cwd ?? process.cwd();
  const timeoutMs = deps.timeoutMs ?? 60_000;

  stdout.write(R.renderBanner(deps.modelLabel, opts));

  const rl: Interface = createInterface({ input: stdin, output: stdout, prompt: '❯ ', terminal: stdout.isTTY === true });
  let pending: PendingRequest | null = null;
  let busy = false;
  let tipIndex = 0;

  // ── 底栏（TTY 专属；非 TTY 零输出——管道消费不被横幅外内容打扰） ──
  let branch: string | null = null;
  let tipTimer: ReturnType<typeof setInterval> | null = null;
  const printToolbar = (thinking: boolean | undefined) => {
    if (!tty) return;
    stdout.write(R.renderToolbar({
      mode: 'agent',
      model: deps.modelLabel,
      thinking,
      cwd,
      branch,
      tip: TIPS[tipIndex % TIPS.length],
      columns: (stdout as NodeJS.WriteStream & { columns?: number }).columns ?? 80,
    }, opts) + '\n');
  };
  if (tty) {
    branch = gitBranch(cwd);
    tipTimer = setInterval(() => { tipIndex++; }, TIP_INTERVAL_MS);
    printToolbar(false);
  }

  const clearPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  /** 审批/澄清/密码广播 → 模式切换（应答经同一 wire RPC 契约回给网关） */
  const onRequest = (ev: { type: string } & Record<string, unknown>) => {
    if (pending) return; // 已有待应答请求（串行化——网关侧 pending 亦各自独立）
    const type = String(ev.type ?? '');
    const requestId = String(ev.request_id ?? '');
    const argsText = (() => {
      try { return JSON.stringify(ev.args ?? {}).slice(0, 160); } catch { return ''; }
    })();
    if (type === 'approval.request') {
      pending = {
        mode: 'approval', requestId, label: `⏸ 审批：${String(ev.tool ?? '')} ${argsText} [y=允许 / s=本次会话 / n=拒绝]`,
        timer: setTimeout(() => { pending = null; stdout.write('\n（审批应答超时——网关已 fail-closed 拒绝）\n'); rl.prompt(); }, timeoutMs),
      };
    } else if (type === 'clarify.request') {
      const choices = Array.isArray(ev.choices) ? ` [${(ev.choices as string[]).join(' / ')}]` : '';
      pending = {
        mode: 'clarify', requestId, label: `❓ 澄清：${String(ev.question ?? '')}${choices}`,
        timer: setTimeout(() => { pending = null; stdout.write('\n（澄清应答超时——按空串处理）\n'); rl.prompt(); }, timeoutMs),
      };
    } else if (type === 'secret.request') {
      pending = {
        mode: 'secret', requestId, label: `🔑 ${String(ev.prompt ?? '')}（输入后回车；仅内存使用不落盘）`,
        timer: setTimeout(() => { pending = null; stdout.write('\n（密码应答超时——按空处理）\n'); rl.prompt(); }, timeoutMs),
      };
    } else if (type === 'form.request') {
      pending = {
        mode: 'form', requestId, label: `📋 表单：${String(ev.prompt ?? '')}（JSON 键值对，如 {"a":"1"}）`,
        timer: setTimeout(() => { pending = null; stdout.write('\n（表单应答超时——按空处理）\n'); rl.prompt(); }, timeoutMs),
      };
    }
    if (pending) {
      stdout.write('\n' + pending.label + '\n');
      rl.setPrompt('  › ');
      rl.prompt();
    }
  };

  // ── 回合渲染上下文（TTY 动画态 + 非 TTY 静态态共用数据结构） ──
  interface TurnRenderCtx {
    turns: number;
    startTs: number;
    /** TTY：思考折叠动画态 */
    thinkingActive: boolean;
    thinkingTokens: number;
    thinkingStartTs: number;
    /** TTY：生成 spinner 行态 */
    composingActive: boolean;
    composingStartTs: number;
    /** TTY：Markdown 增量提交器（非 TTY 为 null——原样直出） */
    streamer: MarkdownStreamer | null;
    contentTokens: number;
    reasoningShown: boolean;
  }

  // 渲染器订阅（每次 run 过滤 runId——多会话/后台任务不串扰）
  let renderOffs: Array<() => void> = [];
  let animTimer: ReturnType<typeof setInterval> | null = null;

  const finishThinkingLine = (ctx: TurnRenderCtx, withNewline: boolean) => {
    if (!ctx.thinkingActive) return;
    ctx.thinkingActive = false;
    if (tty) {
      stdout.write(REDRAW);
      stdout.write(R.renderThoughtFinal({ tokens: Math.round(ctx.thinkingTokens), elapsedMs: Date.now() - ctx.thinkingStartTs }, opts) + (withNewline ? '\n' : ''));
    }
  };
  const finishComposingLine = (ctx: TurnRenderCtx) => {
    if (!ctx.composingActive) return;
    ctx.composingActive = false;
    if (tty) stdout.write(REDRAW);
  };

  const subscribeRender = (runId: string, ctx: TurnRenderCtx) => {
    const handlers: Array<[string, (e: any) => void]> = [
      ['agent.token', (e: any) => {
        if (e?.runId !== runId) return;
        const text = String(e.payload?.text ?? '');
        ctx.contentTokens += estimateTokens(text);
        if (!tty || !ctx.streamer) {
          stdout.write(text); // 非 TTY：原样直出（管道零动画）
          return;
        }
        finishThinkingLine(ctx, true);
        finishComposingLine(ctx);
        for (const block of ctx.streamer.append(text)) {
          stdout.write(block);
          if (!block.endsWith('\n')) stdout.write('\n');
        }
      }],
      ['reasoning.delta', (e: any) => {
        if (e?.runId !== runId) return;
        const text = String(e.payload?.text ?? e.text ?? '');
        ctx.thinkingTokens += estimateTokens(text);
        ctx.reasoningShown = true;
        if (!tty) {
          if (!ctx.thinkingActive && !ctx.composingActive) {
            ctx.thinkingActive = true; // 非 TTY 复用标记仅防重复打印静态折叠行
            stdout.write('\n' + R.renderReasoningLine(0, opts) + '\n');
          }
          return;
        }
        if (!ctx.thinkingActive) {
          ctx.thinkingActive = true;
          ctx.thinkingStartTs = Date.now();
          if (ctx.composingActive) finishComposingLine(ctx);
          stdout.write('\n');
        }
      }],
      ['agent.tool', (e: any) => {
        if (e?.runId !== runId) return;
        const p = e.payload ?? {};
        const name = String(p.name ?? '');
        if (p.phase === 'start') {
          finishThinkingLine(ctx, true);
          finishComposingLine(ctx);
          stdout.write('\n' + R.renderToolHeadline('start', name, extractKeyArgument(p.args, name), opts) + '\n');
        } else if (p.phase === 'complete') {
          const ok = p.ok === true;
          const brief = ok
            ? `${name} 完成 · ${p.ms ?? 0}ms`
            : `失败：${String(p.error ?? '').slice(0, 160) || '未知错误'}`;
          stdout.write(R.renderToolOutcomeLine(ok, brief, opts) + '\n');
        }
      }],
      ['system.notice', (e: any) => {
        if (e?.runId !== runId) return;
        const raw = String(e.payload?.level ?? '');
        const level: R.NoticeSeverity = raw === 'success' || raw === 'warning' || raw === 'error' ? raw : 'info';
        finishThinkingLine(ctx, true);
        finishComposingLine(ctx);
        stdout.write('\n' + R.renderNotification(level, String(e.payload?.text ?? ''), opts) + '\n');
      }],
      ['agent.end', (e: any) => { if (e?.runId === runId) ctx.turns++; }],
    ];
    for (const [type, handler] of handlers) renderOffs.push(deps.bus.on(type, handler));
  };
  const unsubscribeRender = () => { for (const off of renderOffs) off(); renderOffs = []; };

  /** TTY 动画驱动：80ms 重绘思考/生成行（墙上时钟选帧——kimi _bullet_frame_for 语义） */
  const startAnimator = (ctx: TurnRenderCtx) => {
    if (!tty) return;
    if (animTimer) clearInterval(animTimer);
    animTimer = setInterval(() => {
      const now = Date.now();
      if (ctx.thinkingActive) {
        const tokens = Math.round(ctx.thinkingTokens);
        const elapsedMs = now - ctx.thinkingStartTs;
        const rate = elapsedMs > 500 && tokens > 0 ? Math.round(tokens / (elapsedMs / 1000)) : undefined;
        stdout.write(REDRAW + R.renderThinkingLive({ tokens, elapsedMs, frame: thinkBulletFrameAt(now), ratePerSec: rate }, opts));
      } else if (ctx.composingActive) {
        stdout.write(REDRAW + R.renderComposingLive({ tokens: Math.round(ctx.contentTokens), elapsedMs: now - ctx.composingStartTs, frame: spinnerFrameAt(now) }, opts));
      }
    }, 80);
  };
  const stopAnimator = () => { if (animTimer) { clearInterval(animTimer); animTimer = null; } };

  /** 单轮 agent 运行（-p/--wire 同一接纳面；事件过滤 runId 渲染） */
  const runAgentTurn = async (prompt: string): Promise<void> => {
    const runId = randomUUID();
    const correlationId = randomUUID();
    const ctx: TurnRenderCtx = {
      turns: 0, startTs: Date.now(),
      thinkingActive: false, thinkingTokens: 0, thinkingStartTs: 0,
      composingActive: false, composingStartTs: 0,
      streamer: tty ? new MarkdownStreamer() : null,
      contentTokens: 0, reasoningShown: false,
    };
    subscribeRender(runId, ctx);
    if (tty) {
      ctx.composingActive = true;
      ctx.composingStartTs = Date.now();
      stdout.write('\n' + R.renderComposingLive({ tokens: 0, elapsedMs: 0, frame: spinnerFrameAt(Date.now()) }, opts));
      startAnimator(ctx);
    }
    // Ctrl+C 中断（TTY 专属；cancel 与 --wire 同链路）
    const onSigint = () => {
      finishThinkingLine(ctx, true);
      finishComposingLine(ctx);
      stdout.write('\n' + R.renderNoticeLine('已中断当前回合（Ctrl+C）', 'warn', opts) + '\n');
      try { handle.cancel(); } catch { /* 已终态 */ }
    };
    let handle: ReturnType<InteractiveLoopDeps['runInvocation']['invoke']>;
    if (tty) process.once('SIGINT', onSigint);
    try {
      handle = deps.runInvocation.invoke({ kind: 'agent', prompt, runId, correlationId, sessionId: deps.sessionId });
      const run = await handle.completion;
      finishThinkingLine(ctx, true);
      finishComposingLine(ctx);
      stopAnimator();
      if (ctx.streamer) {
        for (const block of ctx.streamer.flush()) {
          stdout.write(block);
          if (!block.endsWith('\n')) stdout.write('\n');
        }
      }
      stdout.write('\n' + R.renderFinalLine(String(run.status), run.status === 'succeeded', opts) + '\n');
      const tokens = Math.round(ctx.thinkingTokens + ctx.contentTokens);
      const summary = R.renderTurnSummaryLine({
        turns: ctx.turns,
        tokens: tokens > 0 ? tokens : undefined,
        durationMs: Date.now() - ctx.startTs,
      }, opts);
      if (summary) stdout.write(summary + '\n');
      stdout.write('\n');
    } finally {
      if (tty) process.removeListener('SIGINT', onSigint);
      unsubscribeRender();
      stopAnimator();
    }
  };

  /** 单轮命令执行（/ 开头直走 commandBus；非 slash 走 routeInput 命令意图） */
  const runCommandTurn = async (command: string): Promise<void> => {
    try {
      const out = await deps.commandBus.execute(command, {});
      const text = (out && typeof out === 'object' && 'output' in (out as Record<string, unknown>))
        ? String((out as Record<string, unknown>).output)
        : typeof out === 'string' ? out : '';
      stdout.write(text ? text + '\n\n' : '\n');
    } catch (e) {
      stdout.write(R.renderNoticeLine(`命令执行失败：${String((e as Error)?.message ?? e).slice(0, 200)}`, 'error', opts) + '\n');
    }
  };

  rl.on('line', (line) => {
    const input = line.trim();
    if (pending) {
      // 应答当前待处理请求（wire 同契约 *.respond）
      const p = pending;
      const answer = p.mode === 'approval' ? mapApprovalAnswer(input) : input;
      clearPending();
      const params: Record<string, unknown> = { request_id: p.requestId, answer };
      void deps.gateway.request(`${p.mode}.respond`, params).catch(() => {});
      rl.setPrompt('❯ ');
      rl.prompt();
      return;
    }
    if (!input) { rl.prompt(); return; }
    if (input === '/exit' || input === '/quit' || input === 'exit') {
      rl.close();
      deps.onExit?.();
      return;
    }
    if (busy) return; // 运行中忽略额外输入（真实中断经 Ctrl+C）
    busy = true;
    void (async () => {
      try {
        if (input.startsWith('/')) {
          await runCommandTurn(input);
        } else if (deps.routeInput) {
          const routed = await deps.routeInput(input);
          if (routed.kind === 'command' && routed.cmd) {
            await runCommandTurn(routed.cmd + (routed.value ? ' ' + routed.value : ''));
          } else {
            await runAgentTurn(input);
          }
        } else {
          await runAgentTurn(input);
        }
      } catch (e) {
        stdout.write(R.renderNoticeLine(`运行失败：${String((e as Error)?.message ?? e).slice(0, 200)}`, 'error', opts) + '\n');
      } finally {
        busy = false;
        if (tty) printToolbar(false);
        rl.prompt();
      }
    })();
  });

  // 应答广播挂载：wire 同款契约（approval/clarify/secret/form.request → *.respond）——
  // 网关由组合根创建（早于本循环），经 setOnRequest 中转器注入本循环的应答处理器。
  deps.setOnRequest?.(onRequest);

  rl.prompt();
  await new Promise<void>(resolve => { rl.on('close', () => resolve()); });
  if (tipTimer) clearInterval(tipTimer);
  clearPending();
}
