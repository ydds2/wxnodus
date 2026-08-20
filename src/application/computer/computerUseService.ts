// src/application/computer/computerUseService.ts — 唯一共享管线：Observe → Resolve → PDP → Authorize → Act → Re-observe → Verify → Evidence
// 阶段顺序固定（计划原文）；driver 无动作/后置条件未通过都不得成功
import type { ComputerAction, ComputerActionContext } from '../../domain/computer/computerAction.js';
import { evaluatePostcondition } from '../../domain/computer/postcondition.js';
import type { OperationResult } from '../../protocol/results.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface ComputerPipelinePorts {
  emergencyStop: { active(): boolean };
  observer: { observe(target: ComputerAction['target'], context: ComputerActionContext, signal: AbortSignal): Promise<OperationResult<unknown>> };
  resolver: { resolve(request: ComputerAction, before: unknown, context: ComputerActionContext): Promise<OperationResult<{ effect: unknown; verification: { verifierId: string; description: string }; action: unknown }>> };
  pdp: { decide(effect: unknown, context: ComputerActionContext): Promise<OperationResult<unknown>> };
  approvals: { authorize(resolved: unknown, policy: unknown, context: ComputerActionContext, signal: AbortSignal): Promise<OperationResult<unknown>> };
  driver: { act(action: unknown, context: ComputerActionContext, signal: AbortSignal): Promise<OperationResult<{ acted: boolean; observed?: unknown }>> };
  postconditions: { verify(verification: { verifierId: string; description: string }, before: unknown, after: unknown, context: ComputerActionContext, signal: AbortSignal): Promise<OperationResult<{ status: 'passed' | 'failed'; observed?: unknown }>> };
  evidence: { closeComputerAction(bundle: unknown): Promise<OperationResult<{ evidenceId: string }>> };
}

export interface ComputerUseResult {
  evidenceId: string;
  observed: unknown;
}

export class ComputerUseService {
  constructor(private readonly ports: ComputerPipelinePorts) {}

  async execute(request: ComputerAction, context: ComputerActionContext, signal: AbortSignal): Promise<OperationResult<ComputerUseResult>> {
    if (this.ports.emergencyStop.active()) return fail('COMPUTER_EMERGENCY_STOP_ACTIVE');
    const before = await this.ports.observer.observe(request.target, context, signal);
    if (!before.ok) return before;
    const resolved = await this.ports.resolver.resolve(request, before.value, context);
    if (!resolved.ok) return resolved;
    const policy = await this.ports.pdp.decide(resolved.value.effect, context);
    if (!policy.ok) return policy;
    const authorized = await this.ports.approvals.authorize(resolved.value, policy.value, context, signal);
    if (!authorized.ok) return authorized;
    const receipt = await this.ports.driver.act(resolved.value.action, context, signal);
    if (!receipt.ok) return receipt;
    if (!receipt.value.acted) return fail('COMPUTER_DRIVER_NO_ACTION');
    const after = await this.ports.observer.observe(request.target, context, signal);
    if (!after.ok) return after;
    const verified = await this.ports.postconditions.verify(resolved.value.verification, before.value, after.value, context, signal);
    if (!verified.ok) return verified;
    const postcondition = evaluatePostcondition(resolved.value.verification, verified.value);
    if (!postcondition.ok) return postcondition;
    const closed = await this.ports.evidence.closeComputerAction({ before: before.value, resolved: resolved.value, policy: policy.value, receipt: receipt.value, after: after.value, verified: verified.value, context });
    if (!closed.ok) return closed;
    return { ok: true, value: { evidenceId: closed.value.evidenceId, observed: after.value } };
  }
}
