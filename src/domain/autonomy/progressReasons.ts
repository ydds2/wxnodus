// src/domain/autonomy/progressReasons.ts — 六类无进展停止原因 + 观测/状态类型
export type ProgressStopReason = 'NO_STATE_CHANGE'|'REPEATED_ACTION'|'REPEATED_ERROR'|
  'NO_NEW_EVIDENCE'|'PLAN_OSCILLATION'|'BUDGET_STAGNATION';
export interface ProgressObservation { stateChanged:boolean; actionKey:string; errorCode:string|null;
  evidenceDelta:number; planRevision:number; planDirection:'forward'|'backward'|'same'; budgetCommittedDelta:number }
export interface ProgressState { runId:string; total:number; noStateChange:number; repeatedAction:number;
  repeatedError:number; noNewEvidence:number; oscillations:number; budgetStagnation:number;
  lastAction:string|null; lastError:string|null; lastDirection:'forward'|'backward'|'same'|null;
  stoppedReason:ProgressStopReason|null }
