// src/application/computer/compatNegotiatorService.ts — CompatNegotiator 应用服务（最小可验证版）：
// 输入三元组（双方 Card + 意图 + 约束包）→ 逐条字段映射机器门 → EARS 可判定校验 → 冻结哈希
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import {
  freezeCompatSpec, validateEarsAcceptance, validateFieldMapping,
  type CompatSpec, type CompatSpecDraft,
} from '../../domain/computer/compatNegotiation.js';
import type { CapabilityCard } from '../../domain/computer/visionCapture.js';

export interface NegotiatorPorts {
  sourceCard(): Promise<OperationResult<CapabilityCard>>;
  targetCard(): Promise<OperationResult<CapabilityCard>>;
}

export class CompatNegotiatorService {
  constructor(private readonly ports: NegotiatorPorts) {}

  /** 双方能力清单 + 用户意图 + 约束包 → 兼容方案 spec（字段映射先过确定性机器门，任何一条失败即整体失败） */
  async negotiate(draft: Omit<CompatSpecDraft, 'parties'> & { parties?: Partial<CompatSpecDraft['parties']> }): Promise<OperationResult<CompatSpec>> {
    const [source, target] = await Promise.all([this.ports.sourceCard(), this.ports.targetCard()]);
    if (!source.ok) return source;
    if (!target.ok) return target;
    for (const mapping of draft.fieldMappings) {
      const checked = validateFieldMapping(mapping, source.value, target.value);
      if (!checked.ok) return checked;
    }
    const acceptance = validateEarsAcceptance(draft.acceptance);
    if (!acceptance.ok) return acceptance;
    if (!draft.parties?.sourceCardId || !draft.parties?.targetCardId) {
      return { ok: false, error: configError('NEGOTIATION_SPEC_INVALID', 'negotiation.spec.invalid', { reason: 'parties' }) };
    }
    return freezeCompatSpec({
      specId: draft.specId,
      intent: draft.intent,
      parties: { sourceCardId: draft.parties.sourceCardId, targetCardId: draft.parties.targetCardId },
      fieldMappings: draft.fieldMappings,
      orchestration: draft.orchestration,
      acceptance: draft.acceptance,
      compliance: draft.compliance,
    });
  }
}
