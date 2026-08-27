// src/presentation/tui/interactiveLoop.ts — 薄层 TUI 交互循环（P2 / Q1，2026-08-27）
// 设计（机制参考 crush/codex REPL 语义·实现原创；V4 决策「薄投影层，绝不引 Ink」）：
//   · 单一 readline 实例 + 模式状态机（prompt / approval / clarify / secret / form）——
//     审批/澄清/密码复用 wire 网关协议（headlessGateway 的 onRequest 广播 + *.respond 应答），
//     与 --wire 前端同一套 RPC 契约，绝无第二套审批通道；
//   · 每轮 agent 运行：runInvocation.invoke（与 -p/--wire 同一接纳面）→ bus 事件过滤 runId
//     → ansiRenderer 纯函数渲染（语义色由结构化事件决定，零正则猜测）；
//   · fail-closed：应答超时由网关层兜底（deny/''/null），TUI 层 pending 镜像定时器同步复位。
import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
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

export async function startInteractiveLoop(deps: InteractiveLoopDeps): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const colors = stdout.isTTY === true;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  stdout.write(R.renderBanner(deps.modelLabel, { colors }));

  const rl: Interface = createInterface({ input: stdin, output: stdout, prompt: '❯ ', terminal: stdout.isTTY === true });
  let pending: PendingRequest | null = null;
  let busy = false;

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

  // 渲染器订阅（每次 run 过滤 runId——多会话/后台任务不串扰）
  let renderOffs: Array<() => void> = [];
  const subscribeRender = (runId: string, ctx: { turns: number; costTokens: number; reasoningShown: boolean; startTs: number }) => {
    const handlers: Array<[string, (e: any) => void]> = [
      ['agent.token', (e: any) => { if (e?.runId !== runId) return; stdout.write(String(e.payload?.text ?? '')); }],
      ['agent.reasoning.delta', (e: any) => {
        if (e?.runId !== runId) return;
        if (!ctx.reasoningShown) { ctx.reasoningShown = true; stdout.write('\n' + R.renderReasoningLine(0, { colors }) + '\n'); }
      }],
      ['agent.tool', (e: any) => {
        if (e?.runId !== runId) return;
        const p = e.payload ?? {};
        if (p.phase === 'start') {
          const summary = (() => { try { return JSON.stringify(p.args ?? {}).slice(0, 160); } catch { return ''; } })();
          stdout.write('\n' + R.renderToolStartLine(String(p.name ?? ''), summary, { colors }) + '\n');
        } else if (p.phase === 'complete') {
          const ok = p.ok === true;
          stdout.write(R.renderToolResultLine(ok ? 'ok' : 'failed', ok ? `${p.ms ?? 0}ms` : '失败', { colors }) + '\n');
        }
      }],
      ['system.notice', (e: any) => {
        if (e?.runId !== runId) return;
        stdout.write(R.renderNoticeLine(String(e.payload?.text ?? ''), 'info', { colors }) + '\n');
      }],
      ['agent.end', (e: any) => { if (e?.runId === runId) ctx.turns++; }],
    ];
    for (const [type, handler] of handlers) renderOffs.push(deps.bus.on(type, handler));
  };
  const unsubscribeRender = () => { for (const off of renderOffs) off(); renderOffs = []; };

  /** 单轮 agent 运行（-p/--wire 同一接纳面；事件过滤 runId 渲染） */
  const runAgentTurn = async (prompt: string): Promise<void> => {
    const runId = randomUUID();
    const correlationId = randomUUID();
    const ctx = { turns: 0, costTokens: 0, reasoningShown: false, startTs: Date.now() };
    subscribeRender(runId, ctx);
    const handle = deps.runInvocation.invoke({ kind: 'agent', prompt, runId, correlationId, sessionId: deps.sessionId });
    const run = await handle.completion;
    unsubscribeRender();
    stdout.write('\n' + R.renderFinalLine(String(run.status), run.status === 'succeeded', { colors }) + '\n');
    const summary = R.renderTurnSummaryLine({ turns: ctx.turns, durationMs: Date.now() - ctx.startTs }, { colors });
    if (summary) stdout.write(summary + '\n');
    stdout.write('\n');
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
      stdout.write(R.renderNoticeLine(`命令执行失败：${String((e as Error)?.message ?? e).slice(0, 200)}`, 'error', { colors }) + '\n');
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
        stdout.write(R.renderNoticeLine(`运行失败：${String((e as Error)?.message ?? e).slice(0, 200)}`, 'error', { colors }) + '\n');
      } finally {
        busy = false;
        rl.prompt();
      }
    })();
  });

  // 应答广播挂载：wire 同款契约（approval/clarify/secret/form.request → *.respond）——
  // 网关由组合根创建（早于本循环），经 setOnRequest 中转器注入本循环的应答处理器。
  deps.setOnRequest?.(onRequest);

  rl.prompt();
  await new Promise<void>(resolve => { rl.on('close', () => resolve()); });
}
