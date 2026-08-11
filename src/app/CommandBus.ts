// src/app/CommandBus.ts — L5 命令执行器
// 设计：处理器注册表 + 别名解析 + 参数拆分 + 异常捕获（输出经消息流呈现）
//       handler 可返回 string（普通输出）或结构化 { kind: 'skill' }（TUI 注入为消息发送）
import { resolveAlias, isSlash } from '../commands/registry.js';

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
      if (!isSlash(trimmed)) return { ok: false, error: '非命令输入' };
      const tokens = trimmed.split(/\s+/);
      const head = tokens[0] ?? '';
      let cmd: string | null = null;
      let argPrefix: string[] = [];
      // 最长命令前缀匹配（子命令优先）：/perm rule list → /perm rule
      // （否则首 token 精确匹配会永久拦截多词命令——/perm rule 被 /perm 吃掉）
      for (let n = tokens.length; n >= 1; n--) {
        const candidate = resolveAlias(tokens.slice(0, n).join(' '));
        if (handlers.has(candidate)) { cmd = candidate; argPrefix = tokens.slice(n); break; }
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
      if (!cmd) return { ok: false, error: `未知命令：${head}（/help 查看）` };
      const fn = handlers.get(cmd)!;
      try {
        const out = await fn(argPrefix, trimmed);
        if (out && typeof out === 'object') {
          // 结构化结果：output 留空，dispatch 携带注入载荷（CLI 侧打印 message 兜底）
          return { ok: true, output: '', dispatch: out };
        }
        return { ok: true, output: out ?? '' };
      } catch (e: any) {
        return { ok: false, error: `命令 ${cmd} 执行失败：${e?.message ?? e}` };
      }
    },
    list: () => [...handlers.keys()],
  };
}
