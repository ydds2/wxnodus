// src/release/releaseEligibility.ts — W0-02：release 放行语义（与 known-failure oracle 严格分离）
// oracle 绿色只证明缺陷稳定复现；release 放行必须：全部 required gate 有终态、无 failed/blocked/cancelled/inconclusive/incomplete/na、
// 且不存在 open P0 blocker。open blocker 存在时即使 gate 已 failed 也写入 reasons，绝不静默吞掉。
import type { RunFinalStatus } from '../protocol/runs.js';

export interface ReleaseGateOutcome {
  gate: string;
  status: string;
}

export interface ReleaseEligibilityInput {
  requiredGates: readonly string[];
  outcomes: readonly ReleaseGateOutcome[];
  openBlockers: readonly string[];
}

export interface ReleaseEligibilityResult {
  status: RunFinalStatus;
  code: string | null;
  reasons: string[];
}

const GATE_TERMINAL = new Set(['passed', 'failed', 'blocked', 'cancelled', 'inconclusive', 'incomplete']);

export function releaseEligibility(input: ReleaseEligibilityInput): ReleaseEligibilityResult {
  const byGate = new Map(input.outcomes.map(outcome => [outcome.gate, outcome.status]));
  const reasons: string[] = [];

  const missing = input.requiredGates.filter(gate => !byGate.has(gate));
  if (missing.length > 0) {
    return {
      status: 'incomplete',
      code: 'RELEASE_GATE_OUTCOME_MISSING',
      reasons: missing.map(gate => `RELEASE_GATE_OUTCOME_MISSING:${gate}`),
    };
  }

  const statuses = input.requiredGates.map(gate => {
    const status = byGate.get(gate)!;
    if (!GATE_TERMINAL.has(status)) {
      return 'inconclusive' as const;
    }
    return status as RunFinalStatus;
  });

  let result: ReleaseEligibilityResult;
  const failed = input.requiredGates.filter(gate => byGate.get(gate) === 'failed');
  if (failed.length > 0) {
    result = {
      status: 'failed',
      code: 'RELEASE_REQUIRED_GATE_FAILED',
      reasons: failed.map(gate => `RELEASE_REQUIRED_GATE_FAILED:${gate}`),
    };
  } else if (statuses.includes('not_applicable' as never)) {
    const na = input.requiredGates.filter(gate => byGate.get(gate) === 'not_applicable');
    result = {
      status: 'blocked',
      code: 'RELEASE_REQUIRED_GATE_NOT_APPLICABLE',
      reasons: na.map(gate => `RELEASE_REQUIRED_GATE_NOT_APPLICABLE:${gate}`),
    };
  } else if (statuses.includes('blocked')) {
    const blocked = input.requiredGates.filter(gate => byGate.get(gate) === 'blocked');
    result = { status: 'blocked', code: 'RELEASE_REQUIRED_GATE_BLOCKED', reasons: blocked.map(gate => `RELEASE_REQUIRED_GATE_BLOCKED:${gate}`) };
  } else if (statuses.includes('cancelled')) {
    const cancelled = input.requiredGates.filter(gate => byGate.get(gate) === 'cancelled');
    result = { status: 'cancelled', code: 'RELEASE_REQUIRED_GATE_CANCELLED', reasons: cancelled.map(gate => `RELEASE_REQUIRED_GATE_CANCELLED:${gate}`) };
  } else if (statuses.includes('inconclusive')) {
    const inconclusive = input.requiredGates.filter(gate => byGate.get(gate) === 'inconclusive' || !GATE_TERMINAL.has(byGate.get(gate)!));
    result = { status: 'inconclusive', code: 'RELEASE_REQUIRED_GATE_INCONCLUSIVE', reasons: inconclusive.map(gate => `RELEASE_REQUIRED_GATE_INCONCLUSIVE:${gate}`) };
  } else if (statuses.includes('incomplete')) {
    const incomplete = input.requiredGates.filter(gate => byGate.get(gate) === 'incomplete');
    result = { status: 'incomplete', code: 'RELEASE_REQUIRED_GATE_INCOMPLETE', reasons: incomplete.map(gate => `RELEASE_REQUIRED_GATE_INCOMPLETE:${gate}`) };
  } else {
    result = { status: 'succeeded', code: null, reasons: [] };
  }

  if (input.openBlockers.length > 0) {
    if (result.status === 'succeeded') {
      return { status: 'blocked', code: 'RELEASE_BLOCKED_OPEN_P0', reasons: [...result.reasons, 'RELEASE_BLOCKED_OPEN_P0'] };
    }
    return { ...result, reasons: [...result.reasons, 'RELEASE_BLOCKED_OPEN_P0'] };
  }
  return result;
}
