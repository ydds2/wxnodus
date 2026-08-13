// src/domain/budget/budgetLedger.ts — 预算账本端口：active snapshot 的 limits/used 预留（超出即拒）
import type { OperationResult } from '../../protocol/results.js';

export interface BudgetLedger {
  /** 校验当前 active snapshot 与上下文 binding 一致，并在同事务内预留预算 */
  reserve(snapshotId: string, reservation: Record<string, number>): OperationResult<{ snapshotId: string; used: Record<string, number> }>;
}
