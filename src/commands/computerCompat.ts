// src/commands/computerCompat.ts — /computer 坐标路径的唯一 ComputerUse 构造点（W3-11 compat 委托：handlersExt 不再直接 new ComputerUse）
import { requireLegacyPath } from '../application/legacy/legacyGuard.js';
import type { ActionGuard } from '../kernel/computer/guards.js';
import type { ComputerUse } from '../kernel/computer/index.js';

export async function createComputerUse(guard: ActionGuard): Promise<ComputerUse> {
  requireLegacyPath('computer-use');
  const { ComputerUse: Constructor } = await import('../kernel/computer/index.js');
  return new Constructor(guard);
}
