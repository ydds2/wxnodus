// src/app/CommandBus.ts — L5 命令执行器
// 设计：处理器注册表 + 别名解析 + 参数拆分 + 异常捕获（输出经消息流呈现）
import { resolveAlias, isSlash } from '../commands/registry.js';

export type CommandHandler = (args: string[], raw: string) => Promise<string | void>;

export interface ExecResult { ok: boolean; output?: string; error?: string }

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
      const [head, ...rest] = trimmed.split(/\s+/);
      const cmd = resolveAlias(head);
      const fn = handlers.get(cmd);
      if (!fn) return { ok: false, error: `未知命令：${head}（/help 查看）` };
      try {
        const out = await fn(rest, trimmed);
        return { ok: true, output: out ?? '' };
      } catch (e: any) {
        return { ok: false, error: `命令 ${cmd} 执行失败：${e?.message ?? e}` };
      }
    },
    list: () => [...handlers.keys()],
  };
}
