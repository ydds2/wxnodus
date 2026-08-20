import { describe, expect, it, vi } from 'vitest';
import { createToolExecutionPipeline, type PipelinePorts } from '../../src/domain/tools/toolExecutionPipeline.js';
import type { EffectDescriptor } from '../../src/domain/effects/effectDescriptor.js';
import type { ToolDescriptor } from '../../src/domain/tools/toolDescriptor.js';
import type { ToolId } from '../../src/domain/tools/toolIds.js';
import { gatewayError } from '../../src/protocol/errors.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';
import { err, ok } from '../../src/protocol/results.js';

const effect: EffectDescriptor = {
  kind: 'filesystem.write', resource: 'file:///workspace/a.txt', operation: 'replace',
  external: false, dataClassification: 'internal', reversibility: 'reversible',
};
const descriptor: ToolDescriptor = {
  id: 'builtin:fs-write' as ToolId, owner: 'builtin:core',
  inputSchema: { type: 'object', required: ['path', 'content'] }, effects: [effect],
  timeoutMs: 5_000, cancellation: 'required', idempotency: 'conditional', evidenceProducer: true,
};
const context: OperationContext = {
  actorId: 'maker-1', sessionId: 'session-1', runId: 'run-1', correlationId: 'corr-1',
  policySnapshotId: 'policy-1', locale: 'zh-CN', source: 'cli', capabilities: [],
  timestamp: '2026-08-13T00:00:00.000Z',
};
const request = { id: 'effect-1', toolId: descriptor.id, args: { path: 'a.txt', content: 'ok' } };

function fixture(overrides: Partial<PipelinePorts> = {}) {
  const order: string[] = [];
  const step = <T>(name: string, value: T) => vi.fn(async () => { order.push(name); return ok(value); });
  const ports: PipelinePorts = {
    resolve: step('resolve', descriptor), validate: step('validate', undefined),
    normalize: step('normalize', { args: request.args, argsHash: 'a'.repeat(64), effect }),
    decide: step('pdp', { action: 'allow' as const, reasonCode: 'POLICY_ALLOW', obligations: [] }),
    authorizeAndReserve: step('authorize-reserve', { reservationId: 'reservation-1' }),
    execute: vi.fn(async () => { order.push('execute'); return ok({ bytesWritten: 2 }); }),
    appendJournal: vi.fn(async state => { order.push(`journal:${state}`); return ok(undefined); }),
    verifyPostcondition: step('postcondition', undefined),
    captureEvidence: step('evidence', ['evidence-1']), commitBudget: step('commit', undefined),
    releaseBudget: step('release', undefined), ...overrides,
  };
  return { order, ports, pipeline: createToolExecutionPipeline(ports) };
}

describe('W1-08 ToolExecutionPipeline', () => {
  it('uses one fixed order and returns only a verified receipt', async () => {
    const { order, pipeline } = fixture();
    const result = await pipeline.execute(request, context, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { effectId: 'effect-1', state: 'verified', evidenceIds: ['evidence-1'] } });
    expect(order).toEqual(['resolve', 'validate', 'normalize', 'pdp', 'authorize-reserve', 'execute', 'journal:applied', 'postcondition', 'evidence', 'commit']);
  });

  it.each(['POLICY_DENIED', 'POLICY_UNAVAILABLE', 'BUDGET_EXCEEDED'] as const)('fails closed on %s before implementation', async code => {
    const execute = vi.fn();
    const { pipeline } = fixture({
      decide: code === 'POLICY_DENIED'
        ? vi.fn(async () => ok({ action: 'deny' as const, reasonCode: code }))
        : vi.fn(async () => err(gatewayError(code, code, code))),
      authorizeAndReserve: code === 'BUDGET_EXCEEDED'
        ? vi.fn(async () => err(gatewayError(code, code, code)))
        : vi.fn(async () => ok({ reservationId: 'unused' })),
      execute,
    });
    const result = await pipeline.execute(request, context, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects string-shaped false success and releases reservation', async () => {
    const releaseBudget = vi.fn(async () => ok(undefined));
    const { pipeline } = fixture({ execute: vi.fn(async () => 'failed' as never), releaseBudget });
    expect(await pipeline.execute(request, context, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'TOOL_RESULT_INVALID' } });
    expect(releaseBudget).toHaveBeenCalledWith('reservation-1', context);
  });

  it('records an applied-but-unverified result when cancellation races with a completed effect', async () => {
    const controller = new AbortController();
    const appendJournal = vi.fn(async () => ok(undefined));
    const releaseBudget = vi.fn(async () => ok(undefined));
    const commitBudget = vi.fn(async () => ok(undefined));
    const { pipeline } = fixture({
      execute: vi.fn(async () => { controller.abort(); return ok({ late: true }); }),
      appendJournal, releaseBudget, commitBudget,
    });
    expect(await pipeline.execute(request, context, controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_CANCELLED', details: { effectState: 'applied_unverified' } },
    });
    expect(appendJournal).toHaveBeenCalledWith('applied', expect.anything(), context);
    expect(appendJournal).toHaveBeenCalledWith('applied_unverified', expect.anything(), context);
    expect(commitBudget).toHaveBeenCalledWith('reservation-1', { late: true }, context);
    expect(releaseBudget).not.toHaveBeenCalled();
  });

  it('commits rather than refunds an applied effect when postcondition verification fails', async () => {
    const releaseBudget = vi.fn(async () => ok(undefined));
    const commitBudget = vi.fn(async () => ok(undefined));
    const appendJournal = vi.fn(async () => ok(undefined));
    const postError = gatewayError('TOOL_POSTCONDITION_FAILED', 'missing', 'tool.postcondition.failed');
    const { pipeline } = fixture({
      verifyPostcondition: vi.fn(async () => err(postError)),
      appendJournal, releaseBudget, commitBudget,
    });
    expect(await pipeline.execute(request, context, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'TOOL_POSTCONDITION_FAILED', details: { effectState: 'applied_unverified' } },
    });
    expect(appendJournal).toHaveBeenCalledWith('applied_unverified', expect.anything(), context);
    expect(commitBudget).toHaveBeenCalledWith('reservation-1', { bytesWritten: 2 }, context);
    expect(releaseBudget).not.toHaveBeenCalled();
  });

  it('turns an execute exception into a structured failure and releases the reservation', async () => {
    const releaseBudget = vi.fn(async () => ok(undefined));
    const appendJournal = vi.fn(async () => ok(undefined));
    const { pipeline } = fixture({
      execute: vi.fn(async () => { throw new Error('boom'); }),
      appendJournal, releaseBudget,
    });
    expect(await pipeline.execute(request, context, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'TOOL_PIPELINE_STAGE_FAILED', details: { stage: 'execute' } },
    });
    expect(appendJournal).toHaveBeenCalledWith('failed', expect.anything(), context);
    expect(releaseBudget).toHaveBeenCalledWith('reservation-1', context);
  });

  it('reports release reconciliation failure instead of hiding a leaked reservation', async () => {
    const { pipeline } = fixture({
      execute: vi.fn(async () => err(gatewayError('TOOL_EXECUTE_FAILED', 'failed', 'tool.execute.failed'))),
      releaseBudget: vi.fn(async () => { throw new Error('release down'); }),
    });
    expect(await pipeline.execute(request, context, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'TOOL_RESERVATION_RECONCILIATION_FAILED', details: { stage: 'release' } },
    });
  });

  it('passes the W1-05 canonical descriptor unchanged to PDP and authorization', async () => {
    const decide = vi.fn(async (_input: unknown) => ok({ action: 'allow' as const, reasonCode: 'POLICY_ALLOW', obligations: [] }));
    const authorizeAndReserve = vi.fn(async (_input: unknown) => ok({ reservationId: 'reservation-1' }));
    const { pipeline } = fixture({ decide, authorizeAndReserve });
    await pipeline.execute(request, context, new AbortController().signal);
    expect((decide.mock.calls[0]?.[0] as { effect: unknown }).effect).toBe(effect);
    expect((authorizeAndReserve.mock.calls[0]?.[0] as { effect: unknown }).effect).toBe(effect);
  });
});
