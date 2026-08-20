// src/application/computer/emergencyStopService.ts — 进程级全局急停：拒绝新动作（COMPUTER_EMERGENCY_STOP_ACTIVE），复位需全新作用域 grant
import type { OperationResult } from '../../protocol/results.js';
import { validateHighImpactGrant, type HighImpactApprovalRequest, type HighImpactGrant } from '../../domain/computer/highImpactApproval.js';

const stopError = (): OperationResult<never> => ({
  ok: false,
  error: { code: 'COMPUTER_EMERGENCY_STOP_ACTIVE', message: 'emergency stop active', messageKey: 'COMPUTER_EMERGENCY_STOP_ACTIVE', retryable: false },
});

export class EmergencyStopService {
  private stopped = false;

  get active(): boolean { return this.stopped; }

  /** 急停：取消运行中/排队中的动作，新动作一律拒绝 */
  stop(): void { this.stopped = true; }

  assertNotStopped(): OperationResult<void> {
    return this.stopped ? stopError() : { ok: true, value: undefined };
  }

  /** 复位需要全新作用域 grant（consumed/漂移 grant 无效），任何场景不可绕过 */
  reset(grant: HighImpactGrant, request: HighImpactApprovalRequest): OperationResult<void> {
    const valid = validateHighImpactGrant(grant, request);
    if (!valid.ok) return valid;
    this.stopped = false;
    return { ok: true, value: undefined };
  }
}
