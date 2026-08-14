// src/commands/computerCompat.ts — /computer 坐标路径的唯一 ComputerUse 构造点（W3-11 compat 委托：handlersExt 不再直接 new ComputerUse）
import { requireLegacyPath } from '../application/legacy/legacyGuard.js';
import type { ActionGuard } from '../kernel/computer/guards.js';
import type { ComputerUse } from '../kernel/computer/index.js';

export async function createComputerUse(guard: ActionGuard): Promise<ComputerUse> {
  requireLegacyPath('computer-use');
  const { ComputerUse: Constructor } = await import('../kernel/computer/index.js');
  return new Constructor(guard);
}

/** W3 Computer facade：kernel 驱动构造（driver 适配面——不触发 legacy path 判定；旧管线入口才是 legacy 语义） */
export async function createKernelComputerUse(guard: ActionGuard): Promise<ComputerUse> {
  const { ComputerUse: Constructor } = await import('../kernel/computer/index.js');
  return new Constructor(guard);
}
