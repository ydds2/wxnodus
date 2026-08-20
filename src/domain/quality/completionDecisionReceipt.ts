// src/domain/quality/completionDecisionReceipt.ts — CompletionDecision 的不可伪造、实例所有权收据
import type { CompletionDecision } from './completionGate.js';
import type { DeepReadonly } from './evidence.js';

export interface CompletionDecisionReceipt {
  readonly decision: DeepReadonly<CompletionDecision>;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export class CompletionDecisionReceiptIssuer {
  readonly #receipts = new WeakSet<object>();

  issue(decision: CompletionDecision): CompletionDecisionReceipt {
    const receipt = Object.freeze({ decision: deepFreeze(structuredClone(decision)) });
    this.#receipts.add(receipt);
    return receipt;
  }

  owns(receipt: unknown): receipt is CompletionDecisionReceipt {
    return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt);
  }
}
