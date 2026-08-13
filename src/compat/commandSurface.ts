// src/compat/commandSurface.ts — 命令面冻结：slash 注册表 / 中文别名 / CLI flags / 命令分级
import { SLASH, COMMAND_CAT, COMMAND_DESC } from '../commands/registry.js';
import { ALIASES, COMMAND_LEVELS } from '../kernel/commandLevels.js';
import { CLI_FLAG_SPEC } from '../cli/args.js';
import { entry } from './descriptors.js';
import type { CompatibilityEntry } from './schema.js';

export function commandSurface(): CompatibilityEntry[] {
  const out: CompatibilityEntry[] = [];

  for (const command of SLASH) {
    out.push(entry('slash', command, {
      description: COMMAND_DESC[command] ?? '',
      category: COMMAND_CAT[command] ?? '',
      level: COMMAND_LEVELS[command] ?? 'unlisted',
    }));
  }

  for (const alias of Object.keys(ALIASES)) {
    out.push(entry('slash', `alias:${alias}`, {
      aliasOf: ALIASES[alias],
      level: COMMAND_LEVELS[ALIASES[alias]!] ?? 'unlisted',
    }));
  }

  // CLI flags：与解析器同源（CLI_FLAG_SPEC），冻结 parser surface（含 help 未列出的 --serve 等）
  for (const flag of CLI_FLAG_SPEC) {
    out.push(entry('cli', flag.long, {
      short: flag.short ?? null,
      key: flag.key,
      takeValue: flag.takeValue ?? false,
      type: flag.type,
    }));
  }

  // 未知 flag 当前被静默忽略——宽松行为不固化，标记为待弃用（未来改为 reject 属 intentional break）
  out.push(entry('cli', 'unknown-flag-policy', { policy: 'ignore' }, 'deprecate', {
    reasonCode: 'unknown_flag_ignored',
    replacement: 'reject with exit 2 and stable reason code',
  }));

  // 命令分级语义：非 slash 输入 / redline 命令在 AI 自主通道一律拒绝
  out.push(entry('slash', 'classify:non-command-input', { level: 'redline', channel: 'wx_cmd' }));
  out.push(entry('slash', 'classify:unlisted-command', { level: 'confirm', channel: 'wx_cmd' }));

  return out;
}
