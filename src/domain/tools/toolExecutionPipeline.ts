// src/domain/tools/toolExecutionPipeline.ts — 唯一副作用执行顺序：resolve→validate→normalize→PDP→authorize→execute→journal→postcondition→evidence→commit
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolDescriptor } from './toolDescriptor.js';
import type { ToolId } from './toolIds.js';
import { gatewayError } from '../../protocol/errors.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ToolExecutionRequest { id: string; toolId: ToolId; args: unknown }
export interface NormalizedExecution { args: unknown; argsHash: string; effect: EffectDescriptor; toolId?: ToolId }
export interface ToolExecutionReceipt { effectId: string; toolId: ToolId; state: 'verified'; value: unknown; evidenceIds: string[]; reservationId?: string }
type Decision = { action: 'allow'; reasonCode: string; obligations: unknown[] } | { action: 'deny'; reasonCode: string } | { action: 'require_approval'; reasonCode: string; obligations: unknown[] };
export interface PipelinePorts {
  resolve(toolId: ToolId): Promise<OperationResult<ToolDescriptor>>;
  validate(descriptor: ToolDescriptor, args: unknown): Promise<OperationResult<void>>;
  normalize(descriptor: ToolDescriptor, args: unknown, context: OperationContext): Promise<OperationResult<NormalizedExecution>>;
  decide(input: NormalizedExecution, context: OperationContext): Promise<OperationResult<Decision>>;
  authorizeAndReserve(input: NormalizedExecution, decision: Decision, context: OperationContext): Promise<OperationResult<{ reservationId?: string }>>;
  execute(descriptor: ToolDescriptor, args: unknown, context: OperationContext, signal: AbortSignal): Promise<unknown>;
  appendJournal(state: 'applied' | 'failed' | 'cancelled', payload: unknown, context: OperationContext): Promise<OperationResult<void>>;
  verifyPostcondition(descriptor: ToolDescriptor, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  captureEvidence(descriptor: ToolDescriptor, value: unknown, context: OperationContext): Promise<OperationResult<string[]>>;
  commitBudget(reservationId: string | undefined, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  releaseBudget(reservationId: string | undefined, context: OperationContext): Promise<OperationResult<void>>;
}
const cancelled = (): OperationResult<never> => err(gatewayError('OPERATION_CANCELLED', 'Operation cancelled', 'operation.cancelled'));
const malformed = (): OperationResult<never> => err(gatewayError('TOOL_RESULT_INVALID', 'Tool must return OperationResult', 'tool.result.invalid'));
const isResult = (value: unknown): value is OperationResult<unknown> => Boolean(value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean');
export function createToolExecutionPipeline(ports: PipelinePorts) {
  return {
    async execute(request: ToolExecutionRequest, context: OperationContext, signal: AbortSignal): Promise<OperationResult<ToolExecutionReceipt>> {
      if (signal.aborted) return cancelled();
      const descriptor = await ports.resolve(request.toolId); if (!descriptor.ok) return descriptor;
      const valid = await ports.validate(descriptor.value, request.args); if (!valid.ok) return valid;
      const normalized = await ports.normalize(descriptor.value, request.args, context); if (!normalized.ok) return normalized;
      const decision = await ports.decide(normalized.value, context); if (!decision.ok) return decision;
      if (decision.value.action === 'deny') return err(gatewayError('POLICY_DENIED', decision.value.reasonCode, 'policy.denied'));
      const reserved = await ports.authorizeAndReserve(normalized.value, decision.value, context); if (!reserved.ok) return reserved;
      if (signal.aborted) { await ports.releaseBudget(reserved.value.reservationId, context); return cancelled(); }
      const raw = await ports.execute(descriptor.value, normalized.value.args, context, signal);
      if (!isResult(raw)) { await ports.releaseBudget(reserved.value.reservationId, context); return malformed(); }
      if (signal.aborted) { await ports.appendJournal('cancelled', { effectId: request.id }, context); await ports.releaseBudget(reserved.value.reservationId, context); return cancelled(); }
      if (!raw.ok) { await ports.appendJournal('failed', { effectId: request.id, code: raw.error.code }, context); await ports.releaseBudget(reserved.value.reservationId, context); return raw as OperationResult<never>; }
      const applied = await ports.appendJournal('applied', { effectId: request.id, value: raw.value }, context); if (!applied.ok) { await ports.releaseBudget(reserved.value.reservationId, context); return applied; }
      const post = await ports.verifyPostcondition(descriptor.value, raw.value, context); if (!post.ok) { await ports.releaseBudget(reserved.value.reservationId, context); return post; }
      const evidence = await ports.captureEvidence(descriptor.value, raw.value, context); if (!evidence.ok) { await ports.releaseBudget(reserved.value.reservationId, context); return evidence; }
      const committed = await ports.commitBudget(reserved.value.reservationId, raw.value, context); if (!committed.ok) return committed;
      return ok({ effectId: request.id, toolId: request.toolId, state: 'verified', value: raw.value, evidenceIds: evidence.value, reservationId: reserved.value.reservationId });
    },
  };
}
export type ToolExecutionPipeline = ReturnType<typeof createToolExecutionPipeline>;
