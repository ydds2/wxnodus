// src/domain/autonomy/autonomyRecords.ts — 自主运行五类记录（Goal/Plan/PlanStep/Run/Attempt）
export type TaskState = 'queued'|'leased'|'running'|'cancelling'|'cancelled'|'completed'|'failed'|'orphaned';
export interface Goal { id: string; objective: string; acceptanceCriteria: string[]; createdAt: string }
export interface Plan { id: string; goalId: string; revision: number; createdAt: string }
export interface PlanStep { id: string; planId: string; ordinal: number; objective: string; state: TaskState }
export interface Run { id: string; goalId: string; planId: string; parentRunId: string|null; state: TaskState; revision: number }
export interface Attempt { id: string; runId: string; planStepId: string; ordinal: number; state: TaskState;
  leaseExpiresAt: string|null; evidenceIds: string[] }
// W2-10：恢复检查点/决策（lease 过期后 CAS orphaned → 稳定决策）
export interface RecoveryCheckpoint { runId: string; attemptId: string; leaseExpiresAt: string; worktreePath: string;
  baseCommit: string; headCommit: string; ownedFiles: string[]; evidenceIds: string[] }
export type RecoveryDecision = 'resume-from-checkpoint' | 'reconcile-worktree' | 'manual-review';
