// src/domain/security/approvalGrant.ts — 授权模型：canonical 哈希绑定完整上下文，nonce 单次消费
import { createHash } from 'node:crypto';
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolId } from '../tools/toolIds.js';

export interface AuthorizationContext { invocationId: string; actorId: string; sessionId: string; runId: string; toolId: ToolId; argsHash: string; effect: EffectDescriptor; resourceHash: string; policySnapshotId: string; budgetSnapshotId: string }
export interface ApprovalGrant { id: string; invocationId: string; actorId: string; sessionId: string; runId: string; toolId: ToolId; argsHash: string; effectHash: string; resourceHash: string; policySnapshotId: string; budgetSnapshotId: string; authorizationContextHash: string; nonce: string; expiresAt: string; status: 'issued' | 'consumed' | 'revoked' }

// canonical：对象 key 递归排序、数组保持顺序、拒绝 undefined/非有限数字（hash 确定性 + 防漂移）
function canonical(value: unknown): string {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw Object.assign(new Error('CANONICAL_VALUE_UNSUPPORTED'), { code: 'CANONICAL_VALUE_UNSUPPORTED' });
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const sha256Canonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const authorizationContextHash = (value: AuthorizationContext) => sha256Canonical(value);
