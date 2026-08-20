// src/presentation/tui/frontend.ts — 前端基座：四个入口（cli/wire/http/tui）共享同一份 事件→纯状态 管线，
// parity 由构造保证——各入口只选 kind，不复制任何投影或传播逻辑
import type { GatewayEvent } from '../../protocol/events.js';
import type { GatewayPort } from '../../protocol/gateway.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';
import type { RunFinalStatus } from '../../protocol/runs.js';
import { assertCompletionPropagation, completionTransport } from '../../protocol/completionTransport.js';
import { TuiEffectExecutor } from './effects/effectExecutor.js';
import { initialTuiState, reduceTui, type TuiState } from './state/reducer.js';
import { projectGatewayEvent } from './state/projector.js';

export type FrontendKind = 'cli' | 'wire' | 'http' | 'tui';

export interface TuiFrontend {
  readonly kind: FrontendKind;
  snapshot(): TuiState;
  /** 完成终态 → 传播三元组（共享表断言：漂移即 FRONTEND_FAILURE_PROPAGATION_MISMATCH） */
  propagate(status: RunFinalStatus): OperationResult<{ processExit: number; httpStatus: number; wireFinal: string }>;
  /** 前端上报的完成终态必须与共享表一致——不一致即 FRONTEND_COMPLETION_MISMATCH（四个入口同判） */
  complete(status: RunFinalStatus, reported?: { wireFinal?: string }): OperationResult<RunFinalStatus>;
  readonly effectExecutor: TuiEffectExecutor;
  dispose(): void;
}

export function createFrontendBase(kind: FrontendKind, gateway: GatewayPort): TuiFrontend {
  let state = initialTuiState();
  const unsubscribe = gateway.subscribe((event: GatewayEvent) => {
    state = projectGatewayEvent(event).reduce(reduceTui, state);
  });
  return {
    kind,
    snapshot: () => state,
    propagate: status => assertCompletionPropagation(status, {}),
    complete(status, reported = {}) {
      const expected = completionTransport[status].wireFinal;
      if (reported.wireFinal !== undefined && reported.wireFinal !== expected) {
        return err({ code: 'FRONTEND_COMPLETION_MISMATCH', message: `frontend ${kind} reported ${reported.wireFinal} for ${status}`, messageKey: 'FRONTEND_COMPLETION_MISMATCH', retryable: false });
      }
      return ok(status);
    },
    effectExecutor: new TuiEffectExecutor(gateway),
    dispose: unsubscribe,
  };
}

