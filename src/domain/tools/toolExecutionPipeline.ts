// src/domain/tools/toolExecutionPipeline.ts — 唯一副作用执行顺序：resolve→validate→normalize→PDP→authorize→execute→journal→postcondition→evidence→commit
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolDescriptor } from './toolDescriptor.js';
import type { ToolId } from './toolIds.js';
import { gatewayError, type GatewayError } from '../../protocol/errors.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ToolExecutionRequest { id: string; toolId: ToolId; args: unknown }
export interface NormalizedExecution { args: unknown; argsHash: string; effect: EffectDescriptor; toolId?: ToolId }
export interface ToolExecutionReceipt { effectId: string; toolId: ToolId; state: 'verified'; value: unknown; evidenceIds: string[]; reservationId?: string }
type Decision = { action: 'allow'; reasonCode: string; obligations: unknown[] } | { action: 'deny'; reasonCode: string } | { action: 'require_approval'; reasonCode: string; obligations: unknown[] };
type JournalState = 'applied' | 'applied_unverified' | 'failed' | 'cancelled';
export interface PipelinePorts {
  resolve(toolId: ToolId): Promise<OperationResult<ToolDescriptor>>;
  validate(descriptor: ToolDescriptor, args: unknown): Promise<OperationResult<void>>;
  normalize(descriptor: ToolDescriptor, args: unknown, context: OperationContext): Promise<OperationResult<NormalizedExecution>>;
  decide(input: NormalizedExecution, context: OperationContext): Promise<OperationResult<Decision>>;
  authorizeAndReserve(input: NormalizedExecution, decision: Decision, context: OperationContext): Promise<OperationResult<{ reservationId?: string }>>;
  execute(descriptor: ToolDescriptor, args: unknown, context: OperationContext, signal: AbortSignal): Promise<unknown>;
  appendJournal(state: JournalState, payload: unknown, context: OperationContext): Promise<OperationResult<void>>;
  verifyPostcondition(descriptor: ToolDescriptor, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  captureEvidence(descriptor: ToolDescriptor, value: unknown, context: OperationContext): Promise<OperationResult<string[]>>;
  commitBudget(reservationId: string | undefined, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  releaseBudget(reservationId: string | undefined, context: OperationContext): Promise<OperationResult<void>>;
}

const isResult = (value: unknown): value is OperationResult<unknown> => Boolean(value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean');
const causeMessage = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 240);
const stageFailure = (stage: string, cause: unknown): GatewayError => gatewayError(
  'TOOL_PIPELINE_STAGE_FAILED',
  `Tool pipeline stage failed (${stage}): ${causeMessage(cause)}`,
  'tool.pipeline.stage.failed',
  { retryable: false, details: { stage } },
);
const reconciliationFailure = (stage: 'release' | 'commit', cause: unknown, originalCode: string): GatewayError => gatewayError(
  'TOOL_RESERVATION_RECONCILIATION_FAILED',
  `Tool reservation reconciliation failed (${stage}): ${causeMessage(cause)}`,
  'tool.reservation.reconciliation.failed',
  { retryable: false, details: { stage, originalCode } },
);
const withEffectState = (error: GatewayError): GatewayError => ({
  ...error,
  details: { ...error.details, effectState: 'applied_unverified' },
});
const cancellationError = (applied = false): GatewayError => gatewayError(
  'OPERATION_CANCELLED',
  'Operation cancelled',
  'operation.cancelled',
  { retryable: false, ...(applied ? { details: { effectState: 'applied_unverified' } } : {}) },
);
const malformed = (): GatewayError => gatewayError('TOOL_RESULT_INVALID', 'Tool must return OperationResult', 'tool.result.invalid');

async function resultStage<T>(stage: string, operation: () => Promise<OperationResult<T>>): Promise<OperationResult<T>> {
  try {
    const result = await operation();
    return isResult(result) ? result as OperationResult<T> : err(stageFailure(stage, 'port returned a non-OperationResult value'));
  } catch (cause) {
    return err(stageFailure(stage, cause));
  }
}

export function createToolExecutionPipeline(ports: PipelinePorts) {
  return {
    async execute(request: ToolExecutionRequest, context: OperationContext, signal: AbortSignal): Promise<OperationResult<ToolExecutionReceipt>> {
      if (signal.aborted) return err(cancellationError());
      const resolved = await resultStage('resolve', () => ports.resolve(request.toolId));
      if (!resolved.ok) return resolved;
      const descriptor = resolved.value;
      const valid = await resultStage('validate', () => ports.validate(descriptor, request.args));
      if (!valid.ok) return valid;
      const normalized = await resultStage('normalize', () => ports.normalize(descriptor, request.args, context));
      if (!normalized.ok) return normalized;
      const decision = await resultStage('decide', () => ports.decide(normalized.value, context));
      if (!decision.ok) return decision;
      if (decision.value.action === 'deny') return err(gatewayError('POLICY_DENIED', decision.value.reasonCode, 'policy.denied'));
      const reserved = await resultStage('authorize', () => ports.authorizeAndReserve(normalized.value, decision.value, context));
      if (!reserved.ok) return reserved;
      const reservationId = reserved.value.reservationId;

      const releaseUnapplied = async (original: GatewayError, state: 'failed' | 'cancelled', payload: unknown): Promise<OperationResult<never>> => {
        const journal = await resultStage('journal', () => ports.appendJournal(state, payload, context));
        const released = await resultStage('release', () => ports.releaseBudget(reservationId, context));
        if (!released.ok) return err(reconciliationFailure('release', released.error, original.code));
        if (!journal.ok) return err(journal.error);
        return err(original);
      };

      const settleAppliedUnverified = async (original: GatewayError, value: unknown, reason: string): Promise<OperationResult<never>> => {
        const marked = await resultStage('journal', () => ports.appendJournal('applied_unverified', {
          effectId: request.id,
          reason,
          code: original.code,
        }, context));
        const committed = await resultStage('commit', () => ports.commitBudget(reservationId, value, context));
        if (!committed.ok) return err(reconciliationFailure('commit', committed.error, original.code));
        if (!marked.ok) return err(withEffectState(marked.error));
        return err(withEffectState(original));
      };

      if (signal.aborted) {
        return releaseUnapplied(cancellationError(), 'cancelled', { effectId: request.id, phase: 'before_execute' });
      }

      let raw: unknown;
      try {
        raw = await ports.execute(descriptor, normalized.value.args, context, signal);
      } catch (cause) {
        const failure = stageFailure('execute', cause);
        return releaseUnapplied(failure, 'failed', { effectId: request.id, code: failure.code, stage: 'execute' });
      }
      if (!isResult(raw)) {
        const failure = malformed();
        return releaseUnapplied(failure, 'failed', { effectId: request.id, code: failure.code });
      }
      if (!raw.ok) {
        return releaseUnapplied(raw.error, 'failed', { effectId: request.id, code: raw.error.code });
      }

      const value = raw.value;
      const applied = await resultStage('journal', () => ports.appendJournal('applied', { effectId: request.id, value }, context));
      if (!applied.ok) return settleAppliedUnverified(applied.error, value, 'applied_journal_failed');
      if (signal.aborted) return settleAppliedUnverified(cancellationError(true), value, 'cancelled_after_execute');

      const post = await resultStage('postcondition', () => ports.verifyPostcondition(descriptor, value, context));
      if (!post.ok) return settleAppliedUnverified(post.error, value, 'postcondition_failed');
      if (signal.aborted) return settleAppliedUnverified(cancellationError(true), value, 'cancelled_after_postcondition');

      const evidence = await resultStage('evidence', () => ports.captureEvidence(descriptor, value, context));
      if (!evidence.ok) return settleAppliedUnverified(evidence.error, value, 'evidence_failed');
      const committed = await resultStage('commit', () => ports.commitBudget(reservationId, value, context));
      if (!committed.ok) return err(reconciliationFailure('commit', committed.error, committed.error.code));
      return ok({ effectId: request.id, toolId: request.toolId, state: 'verified', value, evidenceIds: evidence.value, reservationId });
    },
  };
}
export type ToolExecutionPipeline = ReturnType<typeof createToolExecutionPipeline>;
