// src/app/CommandBus.ts — L5 命令执行器
// 设计：处理器注册表 + 别名解析 + 参数拆分 + 异常捕获（输出经消息流呈现）
//       handler 可返回 string（普通输出）或结构化 { kind: 'skill' }（TUI 注入为消息发送）
import { resolveAlias, isSlash } from '../commands/registry.js';
// W3-01：命令执行结果携带完成终态——各入口（CLI 退出码/HTTP 状态/wire 终态）据此走共享 completionTransport
import type { RunContext, RunFinalStatus } from '../protocol/runs.js';

// A22 指令融合：子命令注入别名（目标命令 + 注入参数）。
// /rewind → /checkpoint restore。（/hole 已注册真实处理器——W7-03 扩展 --code 同化语料检索）
// 与 registry.ALIASES（单 token 纯重定向）互补——语义需子命令的走这里。
const ALIAS_INJECT: Record<string, { args: string[]; cmd: string }> = {
  '/rewind': { cmd: '/checkpoint', args: ['restore'] },
};

export interface CommandExecutionContext {
  signal?: AbortSignal;
  /** 顶层接纳点冻结的身份；嵌套异步工作据此派生 correlation/session/lineage。 */
  runContext?: RunContext;
}

export type CommandHandler = (
  args: string[],
  raw: string,
  context: CommandExecutionContext,
) => CommandOutput | Promise<CommandOutput>;

export type CommandOutput = string | void | StructuredCommand | CommandCompletion;

/** 命令需要把嵌套工作的真实六终态传给顶层 Run 时返回此结构。 */
export interface CommandCompletion {
  kind: 'completion';
  output: string;
  completionStatus: RunFinalStatus;
  error?: string;
}

export function commandCompletion(
  output: string,
  completionStatus: RunFinalStatus,
  error?: string,
): CommandCompletion {
  return { kind: 'completion', output, completionStatus, ...(error ? { error } : {}) };
}

/**
 * Legacy handlers predate CommandCompletion and return a short failure sentence.
 * Keep this adapter deliberately prefix-based so status/help paragraphs containing
 * words such as "未配置" remain successful informational output.
 */
function inferTextCompletion(output: string): CommandCompletion | null {
  const text = output.trim();
  if (!text) return null;
  // V4 L0-5（B-29 修复）：仅保留确定性前缀（取消/拒绝/红线/密钥未配置）——
  // 删除「不可用/未找到/不存在/无法/缺少/超时」等信息词启发式：/doctor「组件 X 不可用」、
  // /mcp list 首个 server 显示不可用等正常信息文案被误判 failed → headless 退出码非零、CI 误判。
  // handler 显式返回 commandCompletion 才携带非成功终态（结构化优先，零内容猜测）。
  if (/^(?:命令已取消|请求已取消|操作已取消|已取消)/.test(text)) {
    return commandCompletion(output, 'cancelled', text);
  }
  if (/^(?:当前未配置|未配置模型密钥|需要模型密钥|需要.*配置|工具被拒绝|权限红线|命令被拒绝|拒绝执行)/.test(text)) {
    return commandCompletion(output, 'blocked', text);
  }
  return null;
}

/** 结构化命令结果（目前仅 skill：把技能正文作为用户消息注入对话） */
export interface StructuredCommand {
  kind: 'skill';
  name: string;
  message?: string;
}

export interface ExecResult {
  ok: boolean;
  output?: string;
  error?: string;
  dispatch?: StructuredCommand;
  /** W3-01：完成终态（供传输层映射退出码/HTTP 状态/wire 终态，failure 不藏在 exit 0/HTTP 200 后面） */
  completionStatus?: RunFinalStatus;
}

export interface CommandBus {
  register(cmd: string, fn: CommandHandler): void;
  unregister(cmd: string): boolean;
  execute(input: string, context?: CommandExecutionContext): Promise<ExecResult>;
  list(): string[];
}

/** 中断竞速：signal 中止时立即以 cancelled 收口——不再等 handler 跑完（TUI Esc 中断长命令等待即回）。
 *  先挂接再查 aborted：handler 首段同步 abort 后抛错时，其 rejection 仍被消费（零未决拒绝） */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, cancelled: () => T): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(cancelled())
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createCommandBus(): CommandBus {
  const handlers = new Map<string, CommandHandler>();

  return {
    register(cmd, fn) {
      handlers.set(cmd, fn);
    },
    unregister(cmd) {
      return handlers.delete(cmd);
    },
    async execute(input, context = {}) {
      const trimmed = input.trim();
      if (context.signal?.aborted) return { ok: false, error: '命令已取消', completionStatus: 'cancelled' };
      if (!isSlash(trimmed)) return { ok: false, error: '非命令输入', completionStatus: 'failed' };
      const tokens = trimmed.split(/\s+/);
      const head = tokens[0] ?? '';
      let cmd: string | null = null;
      let argPrefix: string[] = [];
      // A22 指令融合：子命令注入别名——旧命令名分发重定向到目标命令（/hole X →
      // /memory search X；/rewind → /checkpoint restore）。目标未注册时回退
      // 旧命令本体（/hole 等仍注册）——别名化绝不破坏旧命令。
      const inject = ALIAS_INJECT[head];
      if (inject && handlers.has(inject.cmd)) {
        cmd = inject.cmd;
        argPrefix = [...inject.args, ...tokens.slice(1)];
      }
      // 最长命令前缀匹配（子命令优先）：/perm rule list → /perm rule
      // （否则首 token 精确匹配会永久拦截多词命令——/perm rule 被 /perm 吃掉）
      if (!cmd) {
        for (let n = tokens.length; n >= 1; n--) {
          const candidate = resolveAlias(tokens.slice(0, n).join(' '));
          if (handlers.has(candidate)) { cmd = candidate; argPrefix = tokens.slice(n); break; }
        }
      }
      // `/skill:foo` 冒号参数语法：拆为 cmd=/skill + argPrefix=foo
      // （kimi 风格：/skill:name —— 技能正文注入为消息）
      if (!cmd && head.includes(':')) {
        const [c, ...a] = head.split(':');
        const canon = resolveAlias(c);
        if (handlers.has(canon)) {
          cmd = canon;
          const joined = a.join(':');
          argPrefix = joined ? joined.split(/\s+/) : [];
          if (tokens.length > 1) argPrefix = [...argPrefix, ...tokens.slice(1)];
        }
      }
      if (!cmd) return { ok: false, error: `未知命令：${head}（/help 查看）`, completionStatus: 'failed' };
      const fn = handlers.get(cmd)!;
      try {
        // 中断竞速：abort 立即收口（cancelled）——长命令（/build 等）等待可被 Esc 打断
        const out = await raceAbort(Promise.resolve(fn(argPrefix, trimmed, context)), context.signal, () => undefined);
        if (context.signal?.aborted) return { ok: false, error: '命令已取消', completionStatus: 'cancelled' };
        if (out && typeof out === 'object') {
          if (out.kind === 'completion') {
            return {
              ok: out.completionStatus === 'succeeded',
              output: out.output,
              ...(out.error ? { error: out.error } : {}),
              completionStatus: out.completionStatus,
            };
          }
          // 结构化结果：output 留空，dispatch 携带注入载荷（CLI 侧打印 message 兜底）
          return { ok: true, output: '', dispatch: out, completionStatus: 'succeeded' };
        }
        const text = out ?? '';
        const inferred = inferTextCompletion(text);
        if (inferred) {
          return { ok: false, output: inferred.output, error: inferred.error, completionStatus: inferred.completionStatus };
        }
        return { ok: true, output: text, completionStatus: 'succeeded' };
      } catch (e: any) {
        if (context.signal?.aborted) {
          return { ok: false, error: '命令已取消', completionStatus: 'cancelled' };
        }
        return { ok: false, error: `命令 ${cmd} 执行失败：${e?.message ?? e}`, completionStatus: 'failed' };
      }
    },
    list: () => [...handlers.keys()],
  };
}
