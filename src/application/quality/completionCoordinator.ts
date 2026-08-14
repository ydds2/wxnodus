// src/application/quality/completionCoordinator.ts — CompletionGate 唯一调用与决定收据签发边界
import {
  CompletionDecisionReceiptIssuer,
  type CompletionDecisionReceipt,
} from '../../domain/quality/completionDecisionReceipt.js';
import {
  CompletionGate,
  type CompletionGateInput,
} from '../../domain/quality/completionGate.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export class CompletionCoordinator {
  readonly #issuer = new CompletionDecisionReceiptIssuer();
  readonly #brand = true;

  constructor(private readonly gate: CompletionGate, private readonly clock: () => string = () => new Date().toISOString()) {}

  static isGenuine(value: unknown): value is CompletionCoordinator {
    return typeof value === 'object' && value !== null && #brand in value;
  }

  decide(input: CompletionGateInput): OperationResult<CompletionDecisionReceipt> {
    if (!CompletionGate.isGenuine(this.gate))
      return err(gatewayError('COMPLETION_GATE_UNTRUSTED', 'Completion coordinator requires a genuine gate authority', 'completion.gate.untrusted'));
    let result;
    try {
      result = CompletionGate.prototype.decide.call(this.gate, input, this.clock());
    } catch {
      return err(gatewayError('COMPLETION_GATE_UNTRUSTED', 'Completion coordinator requires a genuine gate authority', 'completion.gate.untrusted'));
    }
    if (!result.ok) return result;
    try {
      return ok(this.#issuer.issue(result.value), result.evidenceIds);
    } catch {
      return err(gatewayError('COMPLETION_RECEIPT_ISSUANCE_FAILED', 'Completion decision receipt issuance failed', 'completion.receipt.issuanceFailed'), result.evidenceIds);
    }
  }

  owns(receipt: unknown): receipt is CompletionDecisionReceipt {
    return this.#issuer.owns(receipt);
  }
}
