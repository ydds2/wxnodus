// src/application/commandRegistry.ts — 命令注册表：owner 化注册、精确错误码、dispose 只移除本人登记项
import { randomUUID } from 'node:crypto';
import type { CommandDefinition, CommandHandler, CommandOutput, CommandRegistration, ParsedCommand } from '../protocol/commands.js';
import type { OperationContext } from '../protocol/operationContext.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

interface Entry {
  id: string;
  definition: CommandDefinition;
  handler: CommandHandler;
}

export function createCommandRegistry() {
  const entries = new Map<string, Entry>();
  return {
    register(definition: CommandDefinition, handler: CommandHandler): OperationResult<CommandRegistration> {
      const name = definition.name.toLowerCase();
      if (entries.has(name)) {
        return err(gatewayError('COMMAND_ALREADY_REGISTERED', `命令已注册：${name}`, 'command.already_registered'));
      }
      const entry: Entry = { id: randomUUID(), definition: { ...definition, name }, handler };
      entries.set(name, entry);
      return ok({
        id: entry.id,
        owner: definition.owner,
        dispose: () => { if (entries.get(name)?.id === entry.id) entries.delete(name); },
      });
    },
    unregisterOwner(owner: string): number {
      let count = 0;
      for (const [name, entry] of entries) {
        if (entry.definition.owner === owner) { entries.delete(name); count++; }
      }
      return count;
    },
    /** W2-04：owner 原子换入（先删旧 owner 全量再注册新条目——单次可见 swap；成功后调用方才 dispose 旧资源） */
    swapOwner(owner: string, incoming: Array<{ definition: CommandDefinition; handler: CommandHandler }>): OperationResult<{ owner: string; replaced: string[] }> {
      const replaced: string[] = [];
      for (const [name, entry] of entries) {
        if (entry.definition.owner === owner) { entries.delete(name); replaced.push(name); }
      }
      for (const item of incoming) {
        const name = item.definition.name.toLowerCase();
        entries.set(name, { id: randomUUID(), definition: { ...item.definition, name }, handler: item.handler });
      }
      return ok({ owner, replaced });
    },
    list(): CommandDefinition[] {
      return [...entries.values()].map(x => x.definition).sort((a, b) => a.name.localeCompare(b.name));
    },
    async execute(input: ParsedCommand, context: OperationContext): Promise<OperationResult<CommandOutput>> {
      const entry = entries.get(input.name.toLowerCase());
      if (!entry) return err(gatewayError('COMMAND_UNKNOWN', `未知命令：${input.name}`, 'command.unknown'));
      if (input.args.length < entry.definition.minArgs) {
        return err(gatewayError('COMMAND_ARGUMENT_MISSING', '命令参数不足', 'command.argument.missing'));
      }
      if (entry.definition.maxArgs !== undefined && input.args.length > entry.definition.maxArgs) {
        return err(gatewayError('COMMAND_ARGUMENT_EXCESS', '命令参数过多', 'command.argument.excess'));
      }
      for (const [name, value] of Object.entries(input.flags)) {
        const spec = entry.definition.flags[name];
        if (!spec) return err(gatewayError('COMMAND_FLAG_UNKNOWN', `未知 flag：--${name}`, 'command.flag.unknown'));
        if (spec.type === 'string' && value === true) {
          return err(gatewayError('COMMAND_FLAG_VALUE_MISSING', `flag 缺值：--${name}`, 'command.flag.value_missing'));
        }
        if (spec.type === 'boolean' && value !== true) {
          return err(gatewayError('COMMAND_FLAG_MALFORMED', `boolean flag 不接受值：--${name}`, 'command.flag.malformed'));
        }
      }
      for (const [name, spec] of Object.entries(entry.definition.flags)) {
        if (spec.required && input.flags[name] === undefined) {
          return err(gatewayError('COMMAND_FLAG_VALUE_MISSING', `缺少 flag：--${name}`, 'command.flag.value_missing'));
        }
      }
      return entry.handler(input, context);
    },
  };
}

export type CommandRegistry = ReturnType<typeof createCommandRegistry>;
