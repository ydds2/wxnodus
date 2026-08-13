// src/presentation/tui/state/reducer.ts — 纯 reducer：无 IO/无定时器/无 React，同一事件序列必然产出同一状态
export type RunProjectionStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'incomplete' | 'inconclusive' | 'cancelled';
export interface TuiState {
  runs: Record<string, { status: RunProjectionStatus; reasons: string[] }>;
  effects: TuiEffect[];
  lastError: { code: string; detail: string } | null;
}
export type TuiEffect =
  | { type: 'gateway.request'; method: string; params: unknown; correlationId: string }
  | { type: 'unsupported'; effectType: string };
export type TuiAction =
  | { type: 'run.started'; runId: string }
  | { type: 'run.completed'; runId: string; status: Exclude<RunProjectionStatus, 'running'>; reasons: string[] }
  | { type: 'effect.queued'; effect: TuiEffect }
  | { type: 'effect.dequeued'; correlationId: string }
  | { type: 'projection.failed'; code: 'TUI_EVENT_UNSUPPORTED'; eventType: string };

export const initialTuiState = (): TuiState => ({ runs: {}, effects: [], lastError: null });

export function reduceTui(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'run.started':
      return { ...state, runs: { ...state.runs, [action.runId]: { status: 'running', reasons: [] } } };
    case 'run.completed':
      return { ...state, runs: { ...state.runs, [action.runId]: { status: action.status, reasons: [...action.reasons] } } };
    case 'effect.queued':
      return { ...state, effects: [...state.effects, action.effect] };
    case 'effect.dequeued':
      return { ...state, effects: state.effects.filter(effect => effect.type !== 'gateway.request' || effect.correlationId !== action.correlationId) };
    case 'projection.failed':
      return { ...state, lastError: { code: action.code, detail: action.eventType } };
  }
}
