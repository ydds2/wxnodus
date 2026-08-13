// tests/integration/computerUsePipeline.test.ts — W3-05：共享管线阶段顺序固定；未授权/无动作/后置条件失败都不得成功
import { describe, expect, it, vi } from 'vitest';
import { ComputerUseService } from '../../src/application/computer/computerUseService.js';
import { createHighImpactApprovalRequest, validateHighImpactGrant } from '../../src/domain/computer/highImpactApproval.js';

const context = { actorId: 'a1', sessionId: 's1', runId: 'r1', effectId: 'e1', correlationId: 'c1' };
const request = {
  kind: 'payment',
  target: { type: 'account', id: 'vendor-7', display: 'Vendor Seven' },
  effect: { summary: 'Pay invoice', parameters: { amount: 125, currency: 'USD' } },
  reversibility: { reversible: false, method: null, deadline: null },
  verification: { verifierId: 'database.query', description: 'ledger contains one settled payment' },
};

function makePorts(overrides: Partial<ConstructorParameters<typeof ComputerUseService>[0]> = {}) {
  const order: string[] = [];
  const record = (name: string) => () => { order.push(name); };
  let observation = 0;
  const ports: ConstructorParameters<typeof ComputerUseService>[0] = {
    emergencyStop: { active: () => false },
    observer: { observe: vi.fn(async () => { record('observe')(); observation += 1; return { ok: true as const, value: { state: observation === 1 ? 'before' : 'after' } }; }) },
    resolver: { resolve: vi.fn(async (_request, _before) => { record('resolve')(); return { ok: true as const, value: { effect: { summary: 'pay' }, verification: { verifierId: 'database.query', description: 'ledger' }, action: { kind: 'payment' } } }; }) },
    pdp: { decide: vi.fn(async () => { record('pdp')(); return { ok: true as const, value: { allow: true } }; }) },
    approvals: { authorize: vi.fn(async () => { record('authorize')(); return { ok: true as const, value: undefined }; }) },
    driver: { act: vi.fn(async () => { record('act')(); return { ok: true as const, value: { acted: true, observed: { exitCode: 0 } } }; }) },
    postconditions: { verify: vi.fn(async () => { record('verify')(); return { ok: true as const, value: { status: 'passed' as const, observed: { rows: 1 } } }; }) },
    evidence: { closeComputerAction: vi.fn(async () => { record('evidence')(); return { ok: true as const, value: { evidenceId: 'ev-1' } }; }) },
    ...overrides,
  };
  return { ports, order };
}

describe('computer use pipeline', () => {
  it('runs the exact stage order and closes evidence only after verified postcondition', async () => {
    const { ports, order } = makePorts();
    const service = new ComputerUseService(ports);
    const result = await service.execute(request, context, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: true, value: { evidenceId: 'ev-1', observed: { state: 'after' } } });
    expect(order).toEqual(['observe', 'resolve', 'pdp', 'authorize', 'act', 'observe', 'verify', 'evidence']);
  });

  it('fails with COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED when authorization is denied and never touches the driver', async () => {
    const { ports, order } = makePorts({
      approvals: { authorize: vi.fn(async () => ({ ok: false as const, error: { code: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', message: 'approval', messageKey: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', retryable: false } })) },
    });
    const service = new ComputerUseService(ports);
    const result = await service.execute(request, context, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED' } });
    expect(ports.driver.act).not.toHaveBeenCalled();
    // 错误码本身证明 authorize 已被咨询并拒绝；order 只记录共享 mocks（override 的 authorize 不记录）
    expect(order).toEqual(['observe', 'resolve', 'pdp']);
  });

  it('fails with COMPUTER_DRIVER_NO_ACTION when the driver did not act', async () => {
    const { ports } = makePorts({
      driver: { act: vi.fn(async () => ({ ok: true as const, value: { acted: false } })) },
    });
    const service = new ComputerUseService(ports);
    const result = await service.execute(request, context, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTER_DRIVER_NO_ACTION' } });
    expect(ports.evidence.closeComputerAction).not.toHaveBeenCalled();
  });

  it('fails with COMPUTER_POSTCONDITION_FAILED when the effect was not verified', async () => {
    const { ports } = makePorts({
      postconditions: { verify: vi.fn(async () => ({ ok: true as const, value: { status: 'failed' as const, observed: { rows: 0 } } })) },
    });
    const service = new ComputerUseService(ports);
    const result = await service.execute(request, context, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTER_POSTCONDITION_FAILED' } });
    expect(ports.evidence.closeComputerAction).not.toHaveBeenCalled();
  });

  it('scoped grants stay single-use through the pipeline boundary', () => {
    const approved = createHighImpactApprovalRequest(
      { kind: 'payment', target: { type: 'account', id: 'v', display: 'v' }, effect: { summary: 'x', parameters: { amount: 1 } }, reversibility: { reversible: false, method: null, deadline: null }, verification: { verifierId: 'database.query', description: 'x' } },
      { actorId: 'a1', sessionId: 's1', runId: 'r1' },
    );
    const grant = { id: 'g', actorId: 'a1', sessionId: 's1', runId: 'r1', requestHash: approved.requestHash, status: 'issued' as const };
    expect(validateHighImpactGrant(grant, approved)).toMatchObject({ ok: true });
    const replayed = createHighImpactApprovalRequest(
      { kind: 'payment', target: { type: 'account', id: 'v', display: 'v' }, effect: { summary: 'x', parameters: { amount: 2 } }, reversibility: { reversible: false, method: null, deadline: null }, verification: { verifierId: 'database.query', description: 'x' } },
      { actorId: 'a1', sessionId: 's1', runId: 'r1' },
    );
    expect(validateHighImpactGrant({ ...grant, status: 'consumed' }, replayed)).toMatchObject({ ok: false, error: { code: 'APPROVAL_GRANT_REPLAYED' } });
  });
});
