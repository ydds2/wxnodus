// src/domain/autonomy/autonomyRecords.ts — 自主运行五类记录（Goal/Plan/PlanStep/Run/Attempt）
export type TaskState = 'queued'|'leased'|'running'|'cancelling'|'cancelled'|'completed'|'failed'|'orphaned';
export interface Goal { id: string; objective: string; acceptanceCriteria: string[]; createdAt: string }
export interface Plan { id: string; goalId: string; revision: number; createdAt: string }
export interface PlanStep { id: string; planId: string; ordinal: number; objective: string; state: TaskState }
export interface Run { id: string; goalId: string; planId: string; parentRunId: string|null; state: TaskState; revision: number }
export interface Attempt { id: string; runId: string; planStepId: string; ordinal: number; state: TaskState;
  leaseExpiresAt: string|null; evidenceIds: string[] }
