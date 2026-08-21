// src/protocol/completionTransport.ts — 完成终态 → 传输层映射（CLI 退出码 / HTTP 状态 / wire 终态，三个入口共享同一张表）
// 任何 failure 都不允许藏在 exit 0 或 HTTP 200 后面。
import { isRunFinalStatus, type RunFinalStatus } from './runs.js';

export const completionTransport = {
  succeeded: { processExit: 0, httpStatus: 200, wireFinal: 'succeeded' },
  failed: { processExit: 1, httpStatus: 422, wireFinal: 'failed' },
  blocked: { processExit: 2, httpStatus: 409, wireFinal: 'blocked' },
  // V4 L0-5：CLI 退出码品类对齐（gemini 语义）——incomplete（轮次上限等未完成态）=53；
  // HTTP/wire 契约不变（424/incomplete）
  incomplete: { processExit: 53, httpStatus: 424, wireFinal: 'incomplete' },
  inconclusive: { processExit: 4, httpStatus: 503, wireFinal: 'inconclusive' },
  cancelled: { processExit: 130, httpStatus: 499, wireFinal: 'cancelled' },
} as const satisfies Record<RunFinalStatus, { processExit: number; httpStatus: number; wireFinal: RunFinalStatus }>;

export type CompletionTransport = typeof completionTransport;
export type CompletionTransportKey = keyof CompletionTransport;

export const processExitForCompletion = (status: RunFinalStatus): number => completionTransport[status].processExit;
export const httpStatusForCompletion = (status: RunFinalStatus): number => completionTransport[status].httpStatus;
export const wireFinalForCompletion = (status: RunFinalStatus): RunFinalStatus => completionTransport[status].wireFinal;

export interface PropagatedCompletion { processExit?: number; httpStatus?: number; wireFinal?: string }

/** 前端上报的传播值必须与共享表一致——不一致即 FRONTEND_FAILURE_PROPAGATION_MISMATCH（fail closed，绝不静默吞掉） */
export function assertCompletionPropagation(
  status: string,
  reported: PropagatedCompletion,
): { ok: true; value: { processExit: number; httpStatus: number; wireFinal: string } } | {
  ok: false;
  error: { code: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH'; message: string; messageKey: string; retryable: false };
} {
  if (!isRunFinalStatus(status)) {
    return { ok: false, error: { code: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH', message: `unknown completion status: ${status}`, messageKey: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH', retryable: false } };
  }
  const expected = completionTransport[status];
  const actual = {
    processExit: reported.processExit ?? expected.processExit,
    httpStatus: reported.httpStatus ?? expected.httpStatus,
    wireFinal: reported.wireFinal ?? expected.wireFinal,
  };
  if (actual.processExit !== expected.processExit || actual.httpStatus !== expected.httpStatus || actual.wireFinal !== expected.wireFinal) {
    return { ok: false, error: { code: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH', message: `completion transport mismatch for ${status}`, messageKey: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH', retryable: false } };
  }
  return { ok: true, value: actual };
}
