// tests/integration/emergencyStop.test.ts — W3-05：进程级急停（新动作拒绝；复位需全新作用域 grant）
import { describe, expect, it, vi } from 'vitest';
import { EmergencyStopService } from '../../src/application/computer/emergencyStopService.js';
import { createHighImpactApprovalRequest } from '../../src/domain/computer/highImpactApproval.js';

const action = {
  kind: 'publish' as const,
  target: { type: 'site' as const, id: 'prod', display: 'prod' },
  effect: { summary: 'publish', parameters: { version: '4.0.0' } },
  reversibility: { reversible: true, method: 'rollback', deadline: null },
  verification: { verifierId: 'http.contract', description: 'site responds 200 on /health' },
};

describe('EmergencyStopService', () => {
  it('stops new work and only resets with a fresh scoped grant', () => {
    const service = new EmergencyStopService();
    expect(service.active).toBe(false);
    service.stop();
    expect(service.active).toBe(true);
    expect(service.assertNotStopped()).toMatchObject({ ok: false, error: { code: 'COMPUTER_EMERGENCY_STOP_ACTIVE' } });

    const request = createHighImpactApprovalRequest(action, { actorId: 'a1', sessionId: 's1', runId: 'r1' });
    const grant = { id: 'g1', actorId: 'a1', sessionId: 's1', runId: 'r1', requestHash: request.requestHash, status: 'issued' as const };
    expect(service.reset(grant, request)).toMatchObject({ ok: true });
    expect(service.active).toBe(false);
  });

  it('refuses to reset with a consumed or drifted grant', () => {
    const service = new EmergencyStopService();
    service.stop();
    const request = createHighImpactApprovalRequest(action, { actorId: 'a1', sessionId: 's1', runId: 'r1' });
    const consumed = { id: 'g1', actorId: 'a1', sessionId: 's1', runId: 'r1', requestHash: request.requestHash, status: 'consumed' as const };
    expect(service.reset(consumed, request)).toMatchObject({ ok: false, error: { code: 'APPROVAL_GRANT_REPLAYED' } });
    const drifted = { ...consumed, status: 'issued' as const, requestHash: '0'.repeat(64) };
    expect(service.reset(drifted, request)).toMatchObject({ ok: false, error: { code: 'APPROVAL_GRANT_SCOPE_MISMATCH' } });
    expect(service.active).toBe(true);
  });

  it('is consulted by the shared pipeline before any driver stage', async () => {
    const { ComputerUseService } = await import('../../src/application/computer/computerUseService.js');
    const stop = new EmergencyStopService();
    stop.stop();
    const observer = { observe: vi.fn(async () => ({ ok: true as const, value: {} })) };
    const service = new ComputerUseService({
      emergencyStop: { active: () => stop.active },
      observer,
      resolver: { resolve: vi.fn() },
      pdp: { decide: vi.fn() },
      approvals: { authorize: vi.fn() },
      driver: { act: vi.fn() },
      postconditions: { verify: vi.fn() },
      evidence: { closeComputerAction: vi.fn() },
    });
    const result = await service.execute(
      { kind: 'delete', target: { type: 'file', id: 'f1' }, effect: { summary: 'delete', parameters: {} } },
      { actorId: 'a', sessionId: 's', runId: 'r', effectId: 'e', correlationId: 'c' },
      AbortSignal.timeout(100),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTER_EMERGENCY_STOP_ACTIVE' } });
    expect(observer.observe).not.toHaveBeenCalled();
  });
});
