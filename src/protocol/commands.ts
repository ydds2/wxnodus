// src/protocol/commands.ts — 命令协议类型（grammar/registry/service 共用）
import type { OperationContext } from './operationContext.js';
import type { OperationResult } from './results.js';

export interface ParsedCommand {
  name: string;
  args: string[];
  flags: Record<string, string | boolean>;
  raw: string;
}

export interface CommandDefinition {
  name: string;
  owner: string;
  minArgs: number;
  maxArgs?: number;
  flags: Readonly<Record<string, { type: 'boolean' | 'string'; required?: boolean }>>;
}

export interface CommandOutput {
  output: string;
}

export type CommandHandler = (input: ParsedCommand, context: OperationContext) => Promise<OperationResult<CommandOutput>>;

export interface CommandRegistration {
  id: string;
  owner: string;
  dispose(): void;
}
