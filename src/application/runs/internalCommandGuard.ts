// src/application/runs/internalCommandGuard.ts — 已持有共享 Agent Run 时的命令重入门
import { resolveAlias } from '../../kernel/commandLevels.js';

const SHARED_AGENT_COMMANDS = new Set([
  '/arena',
  '/flow',
  '/goal',
  '/self-evolve',
]);

/** wx_cmd 已在共享 Agent turn 内；再次调用这些命令会覆盖 turn 或等待自身 FIFO。 */
export function isSharedAgentReentrantCommand(input: string): boolean {
  const head = String(input ?? '').trim().split(/\s+/, 1)[0] ?? '';
  return SHARED_AGENT_COMMANDS.has(resolveAlias(head));
}
