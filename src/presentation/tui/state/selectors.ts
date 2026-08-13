// src/presentation/tui/state/selectors.ts — 纯选择器：只读投影，不做任何状态突变
import type { RunProjectionStatus, TuiEffect, TuiState } from './reducer.js';

export const selectRun = (state: TuiState, runId: string) => state.runs[runId];
export const selectRunStatus = (state: TuiState, runId: string): RunProjectionStatus | undefined => state.runs[runId]?.status;
export const selectRunReasons = (state: TuiState, runId: string): string[] => state.runs[runId]?.reasons ?? [];
export const selectQueuedEffects = (state: TuiState): readonly TuiEffect[] => state.effects;
export const selectLastError = (state: TuiState) => state.lastError;
export const selectRunningRunIds = (state: TuiState): string[] =>
  Object.entries(state.runs).filter(([, run]) => run.status === 'running').map(([runId]) => runId);
export const selectTerminalRunIds = (state: TuiState): string[] =>
  Object.entries(state.runs).filter(([, run]) => run.status !== 'running').map(([runId]) => runId);
