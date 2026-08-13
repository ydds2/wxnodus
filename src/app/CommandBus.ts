// src/app/CommandBus.ts — L5 命令执行器
// 设计：处理器注册表 + 别名解析 + 参数拆分 + 异常捕获（输出经消息流呈现）
//       handler 可返回 string（普通输出）或结构化 { kind: 'skill' }（TUI 注入为消息发送）
import { resolveAlias, isSlash } from '../commands/registry.js';
// W3-01：命令执行结果携带完成终态——各入口（CLI 退出码/HTTP 状态/wire 终态）据此走共享 completionTransport
import type { RunFinalStatus } from '../protocol/runs.js';

// A22 指令融合：子命令注入别名（目标命令 + 注入参数）。
// /hole <查询> → /memory search <查询>；/rewind → /checkpoint restore。
// 与 registry.ALIASES（单 token 纯重定向）互补——语义需子命令的走这里。
const ALIAS_INJECT: Record<string, { args: string[]; cmd: string }> = {
  '/hole': { cmd: '/memory', args: ['search'] },
  '/rewind': { cmd: '/checkpoint', args: ['restore'] },
};

export type CommandHandler = (args: string[], raw: string) => string | void | StructuredCommand | Promise<string | void | StructuredCommand>;

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
  execute(input: string): Promise<ExecResult>;
  list(): string[];
}

export function createCommandBus(): CommandBus {
  const handlers = new Map<string, CommandHandler>();

  return {
    register(cmd, fn) {
      handlers.set(cmd, fn);
    },
    async execute(input) {
      const trimmed = input.trim();
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
        const out = await fn(argPrefix, trimmed);
        if (out && typeof out === 'object') {
          // 结构化结果：output 留空，dispatch 携带注入载荷（CLI 侧打印 message 兜底）
          return { ok: true, output: '', dispatch: out, completionStatus: 'succeeded' };
        }
        return { ok: true, output: out ?? '', completionStatus: 'succeeded' };
      } catch (e: any) {
        return { ok: false, error: `命令 ${cmd} 执行失败：${e?.message ?? e}`, completionStatus: 'failed' };
      }
    },
    list: () => [...handlers.keys()],
  };
}
