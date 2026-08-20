// src/domain/security/pdp.ts — 策略决策点端口：policy snapshot 加载与 effect 决策（fail closed）
import type { OperationResult } from '../../protocol/results.js';
import type { EffectDescriptor } from '../effects/effectDescriptor.js';

export interface PolicyRule { effectKind: string; action: 'allow' | 'deny' | 'require_approval' }
export interface PolicyDocument { version: 1; hardRedlineKinds: string[]; rules: PolicyRule[] }
export interface PolicySnapshot { id: string; checksum: string; document: PolicyDocument }

export interface PolicyDecisionPoint {
  /** 加载当前 active snapshot；不可用/损坏/checksum 漂移 → POLICY_UNAVAILABLE（绝不放行） */
  loadActive(): OperationResult<PolicySnapshot>;
  /** effect 决策：hard redline → deny；规则命中按 action；无规则 → deny（fail closed） */
  decide(document: PolicyDocument, effect: EffectDescriptor): 'allow' | 'deny' | 'require_approval';
}

export function decideEffect(document: PolicyDocument, effectKind: string): 'allow' | 'deny' | 'require_approval' {
  if (document.hardRedlineKinds.includes(effectKind)) return 'deny';
  return document.rules.find(rule => rule.effectKind === effectKind)?.action ?? 'deny';
}
