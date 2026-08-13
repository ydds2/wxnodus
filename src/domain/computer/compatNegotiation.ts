// src/domain/computer/compatNegotiation.ts — CompatNegotiator 契约（蓝图 §4 最小可验证版）：
// 字段映射确定性机器门（来源存在性/目标存在性/转换可判定——LLM 提议、机器裁决，拦截不重试即兴）
// + EARS 可判定验收（禁主观词）+ spec 冻结哈希（stableStringify → sha256 前 12 位，阶段重算防漂移）
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../config/configSchema.js';
import type { CapabilityCard } from './visionCapture.js';

export const REGISTERED_TRANSFORMS = ['trim', 'lower', 'divide_100', 'format_date', 'identity'] as const;
export type TransformName = typeof REGISTERED_TRANSFORMS[number];

export interface FieldMapping { from: string; to: string; transform: TransformName }
export interface Orchestration { direction: 'one_way' | 'two_way'; trigger: { type: 'poll' | 'event' | 'manual'; intervalSec?: number } }
export interface CompatSpecDraft {
  specId: string;
  intent: string;
  parties: { sourceCardId: string; targetCardId: string };
  fieldMappings: FieldMapping[];
  orchestration: Orchestration;
  acceptance: string[];
  compliance: { channelClass: 'P0' | 'P1' | 'P2' | 'P3' | 'blocked' };
}
export interface CompatSpec extends CompatSpecDraft { specHash: string }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** spec_id 允许中文（蓝图示例 cs_订单同步_001）：非空白、非控制字符、≤64 */
const SPEC_ID = /^[^\s\u0000-\u001f\u007f]{1,64}$/;
/** EARS 主观词禁令：验收标准必须可客观判定真伪（蓝图 §4.1.2） */
const SUBJECTIVE_WORDS = ['尽量', '可能', '大约', '尽快', '合理', '合适', '酌情', '大概', '也许', 'roughly', 'probably', 'soon', 'reasonable', 'maybe', 'asap'];
const REJECTED_TRANSFORMS = new Set(SUBJECTIVE_WORDS);

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

/** 机器门三规则（蓝图 §4.2.1）：
 * 1) 来源存在性——from 必须真实出现在源 Card 的 outputs schema 或证据锚点；
 * 2) 目标存在性——to 必须真实出现在目标 Card 的 inputs schema；
 * 3) 转换可判定——transform 必须是注册的确定性函数集（禁自由文本描述）。 */
export function validateFieldMapping(
  mapping: FieldMapping,
  source: CapabilityCard,
  target: CapabilityCard,
): OperationResult<void> {
  const sourceFields = new Set([
    ...source.capabilities.flatMap(cap => Object.keys(cap.outputSchema?.properties ?? {})),
    ...source.capabilities.flatMap(cap => cap.evidenceAnchors),
  ]);
  const targetFields = new Set(target.capabilities.flatMap(cap => Object.keys(cap.inputSchema?.properties ?? {})));
  if (!sourceFields.has(mapping.from)) {
    return { ok: false, error: configError('NEGOTIATION_MAPPING_SOURCE_MISSING', 'negotiation.mapping.source.missing', { from: mapping.from }) };
  }
  if (!targetFields.has(mapping.to)) {
    return { ok: false, error: configError('NEGOTIATION_MAPPING_TARGET_MISSING', 'negotiation.mapping.target.missing', { to: mapping.to }) };
  }
  if (!(REGISTERED_TRANSFORMS as readonly string[]).includes(mapping.transform)) {
    return { ok: false, error: configError('NEGOTIATION_MAPPING_TRANSFORM_UNKNOWN', 'negotiation.mapping.transform.unknown', { transform: mapping.transform }) };
  }
  return { ok: true, value: undefined };
}

/** EARS 可判定校验：禁主观词、禁空文本 */
export function validateEarsAcceptance(acceptance: string[]): OperationResult<void> {
  if (acceptance.length === 0) {
    return { ok: false, error: configError('NEGOTIATION_ACCEPTANCE_NOT_OBJECTIVE', 'negotiation.acceptance.empty') };
  }
  for (const text of acceptance) {
    if (!text.trim() || [...REJECTED_TRANSFORMS].some(word => text.toLowerCase().includes(word.toLowerCase()))) {
      return { ok: false, error: configError('NEGOTIATION_ACCEPTANCE_NOT_OBJECTIVE', 'negotiation.acceptance.subjective', { text }) };
    }
  }
  return { ok: true, value: undefined };
}

/** 冻结：stableStringify（canonical 排序）→ sha256 前 12 位 spec_hash（蓝图 §4.1.2） */
export function freezeCompatSpec(draft: CompatSpecDraft): OperationResult<CompatSpec> {
  if (!SPEC_ID.test(draft.specId)) return { ok: false, error: configError('NEGOTIATION_SPEC_INVALID', 'negotiation.spec.invalid') };
  if (!draft.intent.trim() || !SAFE_ID.test(draft.parties.sourceCardId) || !SAFE_ID.test(draft.parties.targetCardId)) {
    return { ok: false, error: configError('NEGOTIATION_SPEC_INVALID', 'negotiation.spec.invalid') };
  }
  if (draft.fieldMappings.length === 0) return { ok: false, error: configError('NEGOTIATION_SPEC_INVALID', 'negotiation.spec.noMappings') };
  const acceptance = validateEarsAcceptance(draft.acceptance);
  if (!acceptance.ok) return acceptance;
  const specHash = createHash('sha256').update(canonical(draft)).digest('hex').slice(0, 12);
  return { ok: true, value: { ...draft, specHash } };
}

/** 阶段重算比对：不一致即 NEGOTIATION_SPEC_DRIFT（防意图漂移） */
export function verifyCompatSpec(spec: CompatSpec): OperationResult<void> {
  const { specHash: _omitted, ...draft } = spec;
  const recomputed = createHash('sha256').update(canonical(draft)).digest('hex').slice(0, 12);
  return recomputed === spec.specHash ? { ok: true, value: undefined } : {
    ok: false,
    error: configError('NEGOTIATION_SPEC_DRIFT', 'negotiation.spec.drift', { expected: spec.specHash, actual: recomputed }),
  };
}
