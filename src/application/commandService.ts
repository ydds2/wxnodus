// src/application/commandService.ts — CommandService 端口 + 基于 grammar/registry 的 factory
import type { OperationContext } from '../protocol/operationContext.js';
import type { OperationResult } from '../protocol/results.js';
import type { CommandRegistry } from './commandRegistry.js';
import { parseCommand } from './commandGrammar.js';

export interface CommandService {
  execute(input: { raw: string; sessionId: string }, context: OperationContext): Promise<OperationResult<{ output: string }>>;
}

export function createCommandService(
  registry: CommandRegistry,
  _chatFallback: (text: string) => unknown,
): CommandService {
  return {
    async execute(input, context) {
      const parsed = parseCommand(input.raw);
      if (!parsed.ok) return parsed;
      return registry.execute(parsed.value, { ...context, sessionId: input.sessionId });
    },
  };
}
