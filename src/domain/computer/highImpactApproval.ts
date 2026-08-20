// src/domain/computer/highImpactApproval.ts — 高影响动作授权：canonical hash 绑定全参数，grant 单次使用、作用域漂移即失效（计划原文）
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';

export type HighImpactKind = 'external-send' | 'delete' | 'payment' | 'publish' | 'system-config';
export interface HighImpactAction {
  kind: HighImpactKind;
  target: { type: string; id: string; display: string };
  effect: { summary: string; parameters: Record<string, string | number | boolean | null> };
  reversibility: { reversible: boolean; method: string | null; deadline: string | null };
  verification: { verifierId: string; description: string };
}
export interface HighImpactApprovalRequest extends HighImpactAction {
  ruleId: `computer.high-impact.${HighImpactKind}.v1`;
  actionKind: HighImpactKind;
  actorId: string;
  sessionId: string;
  runId: string;
  requestHash: string;
}
export interface HighImpactGrant {
  id: string;
  actorId: string;
  sessionId: string;
  runId: string;
  requestHash: string;
  status: 'issued' | 'consumed' | 'revoked';
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

export function createHighImpactApprovalRequest(
  action: HighImpactAction,
  context: { actorId: string; sessionId: string; runId: string },
): HighImpactApprovalRequest {
  const body = { ...action, actionKind: action.kind, ...context, ruleId: `computer.high-impact.${action.kind}.v1` as const };
  return { ...body, requestHash: createHash('sha256').update(canonical(body)).digest('hex') };
}

export function validateHighImpactGrant(
  grant: HighImpactGrant,
  request: HighImpactApprovalRequest,
): OperationResult<void> {
  const matches = grant.status === 'issued' && grant.actorId === request.actorId &&
    grant.sessionId === request.sessionId && grant.runId === request.runId && grant.requestHash === request.requestHash;
  return matches ? { ok: true, value: undefined } : {
    ok: false,
    error: {
      code: grant.status === 'consumed' ? 'APPROVAL_GRANT_REPLAYED' : 'APPROVAL_GRANT_SCOPE_MISMATCH',
      message: 'High-impact approval grant does not match the canonical request',
      messageKey: 'APPROVAL_GRANT_SCOPE_MISMATCH',
      retryable: false,
    },
  };
}
