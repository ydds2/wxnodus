// src/domain/computer/postcondition.ts — 动作后置条件：driver 收据未经验证的效果不得成功（COMPUTER_POSTCONDITION_FAILED）
import type { OperationResult } from '../../protocol/results.js';

export interface PostconditionVerification { verifierId: string; description: string }
export interface PostconditionResult { status: 'passed' | 'failed'; observed?: unknown }

export function evaluatePostcondition(
  verification: PostconditionVerification,
  result: PostconditionResult,
): OperationResult<{ verifierId: string; observed: unknown }> {
  if (result.status === 'passed') return { ok: true, value: { verifierId: verification.verifierId, observed: result.observed } };
  return {
    ok: false,
    error: {
      code: 'COMPUTER_POSTCONDITION_FAILED',
      message: `postcondition failed: ${verification.verifierId} — ${verification.description}`,
      messageKey: 'COMPUTER_POSTCONDITION_FAILED',
      retryable: false,
      details: { verifierId: verification.verifierId, observed: result.observed },
    },
  };
}
