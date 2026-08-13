// src/application/commandGrammar.ts — 命令词法/语法：引号、转义、flag、-- 终结符（全入口共享 raw grammar）
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';
import type { ParsedCommand } from '../protocol/commands.js';

function tokenize(raw: string): OperationResult<string[]> {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let active = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === '\\' && raw[i + 1] !== undefined) {
        const next = raw[i + 1]!;
        if (next === quote || next === '\\') { token += next; i++; } else token += ch;
      } else if (ch === quote) quote = null;
      else token += ch;
      active = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (/\s/.test(ch)) {
      if (active) { tokens.push(token); token = ''; active = false; }
      continue;
    }
    token += ch;
    active = true;
  }
  if (quote) return err(gatewayError('COMMAND_PARSE_UNTERMINATED_QUOTE', '命令引号未闭合', 'command.quote.unterminated'));
  if (active) tokens.push(token);
  return ok(tokens);
}

export function parseCommand(raw: string): OperationResult<ParsedCommand> {
  const lexed = tokenize(raw.trim());
  if (!lexed.ok) return lexed;
  const [name, ...tail] = lexed.value;
  if (!name?.startsWith('/')) return err(gatewayError('COMMAND_NOT_SLASH', '输入不是 slash command', 'command.not_slash'));
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let parseFlags = true;
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]!;
    if (parseFlags && token === '--') { parseFlags = false; continue; }
    if (parseFlags && token.startsWith('--')) {
      const body = token.slice(2);
      if (!body || body.startsWith('-')) return err(gatewayError('COMMAND_FLAG_MALFORMED', 'flag 格式错误', 'command.flag.malformed'));
      const equals = body.indexOf('=');
      if (equals >= 0) {
        const key = body.slice(0, equals);
        const value = body.slice(equals + 1);
        if (!key || !value) return err(gatewayError('COMMAND_FLAG_MALFORMED', 'flag 格式错误', 'command.flag.malformed'));
        flags[key] = value;
      } else if (tail[i + 1] !== undefined && !tail[i + 1]!.startsWith('--')) {
        flags[body] = tail[++i]!;
      } else flags[body] = true;
      continue;
    }
    args.push(token);
  }
  return ok({ name: name.toLowerCase(), args, flags, raw });
}
