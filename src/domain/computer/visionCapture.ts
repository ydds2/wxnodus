// src/domain/computer/visionCapture.ts — VisionCapture 录制层契约（蓝图 §3 最小可验证版）：
// 视觉三元组（帧引用+坐标/动作+语义锚点）+ 流量通道（操作→端点对照）→ <untrusted_recorded_trace> 隔离 → Capability Card 归纳
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../config/configSchema.js';

export type RecordedActionKind = 'click' | 'type' | 'press' | 'scroll' | 'invoke' | 'select' | 'set-value';
export interface RecordedFrameRef { sha256: string; bytes: number }
export interface RecordedNetworkEvent { method: string; url: string; status: number }
export interface RecordedStep {
  index: number;
  pageId: string;
  action: { kind: RecordedActionKind; params: Record<string, string | number | boolean | null> };
  /** DOM/UIA 语义锚点（role/name/层级路径——非脆弱 XPath） */
  anchor: { role: string; name: string; path: string[] } | null;
  frameBefore: RecordedFrameRef | null;
  frameAfter: RecordedFrameRef | null;
  network: RecordedNetworkEvent[];
  ts: string;
}
export interface RecordedTrace {
  schemaVersion: 1;
  traceId: string;
  source: 'browser' | 'uia';
  steps: RecordedStep[];
  sha256: string;
}

/** <untrusted_*> 隔离（蓝图：录制内容进入归纳层前必须包裹，归纳层拒绝裸输入） */
export interface Untrusted<T extends string, P> { tag: `untrusted_${T}`; payload: P }
export type UntrustedTrace = Untrusted<'recorded_trace', RecordedTrace>;

export function wrapUntrusted<T extends string, P>(tag: T, payload: P): Untrusted<T, P> {
  return Object.freeze({ tag: `untrusted_${tag}` as const, payload });
}
export function isUntrustedWrapper<T extends string>(value: unknown, tag: T): value is Untrusted<T, unknown> {
  return typeof value === 'object' && value !== null && (value as Untrusted<T, unknown>).tag === `untrusted_${tag}` &&
    Object.hasOwn(value as object, 'payload');
}

export const FRAME_SHA = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

export const traceSha256 = (trace: Omit<RecordedTrace, 'sha256'>): string =>
  createHash('sha256').update(canonical(trace)).digest('hex');

export function validateRecordedTrace(value: unknown): OperationResult<RecordedTrace> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: configError('VISION_CAPTURE_TRACE_INVALID', 'visionCapture.trace.invalid') };
  }
  const raw = value as Record<string, unknown>;
  const steps = raw.steps;
  const stepsValid = Array.isArray(steps) && steps.every((step, index) => {
    if (typeof step !== 'object' || step === null) return false;
    const item = step as Record<string, unknown>;
    const frame = (ref: unknown) => ref === null ||
      (typeof ref === 'object' && ref !== null && FRAME_SHA.test((ref as RecordedFrameRef).sha256) &&
       Number.isInteger((ref as RecordedFrameRef).bytes) && (ref as RecordedFrameRef).bytes >= 0);
    const anchor = item.anchor === null || (typeof item.anchor === 'object' && item.anchor !== null &&
      typeof (item.anchor as RecordedStep['anchor'])?.role === 'string' &&
      typeof (item.anchor as RecordedStep['anchor'])?.name === 'string' &&
      Array.isArray((item.anchor as RecordedStep['anchor'])?.path));
    return item.index === index && typeof item.pageId === 'string' && item.pageId.length > 0 &&
      typeof item.action === 'object' && item.action !== null &&
      typeof (item.action as RecordedStep['action']).kind === 'string' &&
      typeof (item.action as RecordedStep['action']).params === 'object' &&
      anchor && frame(item.frameBefore) && frame(item.frameAfter) &&
      Array.isArray(item.network) && item.network.every(ev => typeof ev === 'object' && ev !== null &&
        typeof (ev as RecordedNetworkEvent).method === 'string' && typeof (ev as RecordedNetworkEvent).url === 'string' &&
        Number.isInteger((ev as RecordedNetworkEvent).status)) &&
      typeof item.ts === 'string';
  });
  const traceSha = raw.sha256;
  if (raw.schemaVersion !== 1 || typeof raw.traceId !== 'string' || !SAFE_ID.test(raw.traceId) ||
      (raw.source !== 'browser' && raw.source !== 'uia') || !stepsValid ||
      typeof traceSha !== 'string' || !FRAME_SHA.test(traceSha)) {
    return { ok: false, error: configError('VISION_CAPTURE_TRACE_INVALID', 'visionCapture.trace.invalid') };
  }
  return { ok: true, value: raw as unknown as RecordedTrace };
}

// ── Capability Card 归纳合同（蓝图 §3.2 最小可验证版：按 (action kind × anchor role) 归纳，参数键提升为槽位） ──
export interface CapabilityCardCapability {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  preconditions: Array<{ kind: 'auth' | 'login'; status: 'pending' | 'satisfied' }>;
  evidenceAnchors: string[];
}
export interface CapabilityCard {
  cardId: string;
  origin: { kind: 'site' | 'system' | 'device'; id: string };
  capabilities: CapabilityCardCapability[];
  sha256: string;
}

export function validateCapabilityCard(value: unknown): OperationResult<CapabilityCard> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: configError('VISION_CAPTURE_CARD_INVALID', 'visionCapture.card.invalid') };
  }
  const raw = value as Record<string, unknown>;
  const caps = raw.capabilities;
  const capsValid = Array.isArray(caps) && caps.length > 0 && caps.every(cap => {
    if (typeof cap !== 'object' || cap === null) return false;
    const item = cap as Record<string, unknown>;
    return typeof item.id === 'string' && SAFE_ID.test(item.id) &&
      typeof item.description === 'string' && item.description.length > 0 &&
      typeof item.inputSchema === 'object' && item.inputSchema !== null &&
      typeof item.outputSchema === 'object' && item.outputSchema !== null &&
      Array.isArray(item.preconditions) && item.preconditions.every(pc =>
        typeof pc === 'object' && pc !== null &&
        ((pc as { kind: unknown }).kind === 'auth' || (pc as { kind: unknown }).kind === 'login') &&
        ((pc as { status: unknown }).status === 'pending' || (pc as { status: unknown }).status === 'satisfied')) &&
      Array.isArray(item.evidenceAnchors) && item.evidenceAnchors.length > 0 &&
      item.evidenceAnchors.every(anchor => typeof anchor === 'string');
  });
  if (typeof raw.cardId !== 'string' || !SAFE_ID.test(raw.cardId) ||
      typeof raw.origin !== 'object' || raw.origin === null ||
      !['site', 'system', 'device'].includes((raw.origin as { kind: string }).kind) ||
      typeof (raw.origin as { id: unknown }).id !== 'string' || !(raw.origin as { id: string }).id ||
      !capsValid || typeof raw.sha256 !== 'string' || !FRAME_SHA.test(raw.sha256 as string)) {
    return { ok: false, error: configError('VISION_CAPTURE_CARD_INVALID', 'visionCapture.card.invalid') };
  }
  return { ok: true, value: raw as unknown as CapabilityCard };
}

export const cardSha256 = (card: Omit<CapabilityCard, 'sha256'>): string =>
  createHash('sha256').update(canonical(card)).digest('hex');
