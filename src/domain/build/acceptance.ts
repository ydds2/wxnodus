// src/domain/build/acceptance.ts — 验收标准严格结构化契约（计划原文）：required 标准必须带 verifier/expected/evidence 字段
import type { OperationResult } from '../../protocol/results.js';
export interface AcceptanceCriterion {
  id: string;
  required: boolean;
  description: string;
  verifierId: string;
  expected: unknown;
  evidenceRequirements: string[];
}
export function validateAcceptance(input: unknown): OperationResult<AcceptanceCriterion[]> {
  if (!Array.isArray(input) || input.length === 0) return invalid();
  const valid = input.every(value => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<AcceptanceCriterion>;
    return typeof item.id === 'string' && item.id.length > 0 &&
      typeof item.required === 'boolean' && typeof item.description === 'string' && item.description.length > 0 &&
      typeof item.verifierId === 'string' && item.verifierId.length > 0 &&
      Object.hasOwn(item, 'expected') && Array.isArray(item.evidenceRequirements);
  });
  return valid ? { ok: true, value: input as AcceptanceCriterion[] } : invalid();
}
const invalid = (): OperationResult<never> => ({
  ok: false,
  error: { code: 'BUILD_SPEC_INVALID', message: 'Acceptance criteria are incomplete', messageKey: 'BUILD_SPEC_INVALID', retryable: false },
});
