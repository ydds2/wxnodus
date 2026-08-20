// src/application/computer/visionCaptureService.ts — VisionCapture 应用服务（最小可验证版）：
// 录制会话追加步骤 → seal（sha256 绑定）→ <untrusted_recorded_trace> 隔离 → 归纳为 Capability Card
// 归纳层只接受 untrusted 包裹（拒绝裸输入：VISION_CAPTURE_UNTRUSTED_INPUT）；归纳结果确定性（排序 + 槽位从参数键提升）
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import {
  cardSha256, traceSha256, validateCapabilityCard, validateRecordedTrace, wrapUntrusted,
  type CapabilityCard, type RecordedActionKind, type RecordedStep, type RecordedTrace, type UntrustedTrace,
} from '../../domain/computer/visionCapture.js';

export interface VisionCaptureSession {
  traceId: string;
  source: 'browser' | 'uia';
  steps: RecordedStep[];
}

export class VisionCaptureService {
  constructor(private readonly ports: { now(): string }) {}

  openSession(traceId: string, source: 'browser' | 'uia'): VisionCaptureSession {
    return { traceId, source, steps: [] };
  }

  recordStep(session: VisionCaptureSession, step: Omit<RecordedStep, 'index' | 'ts'>): OperationResult<void> {
    const { frameBefore, frameAfter, action, anchor, network, pageId } = step;
    if (!frameBefore || !frameAfter) {
      return { ok: false, error: configError('VISION_CAPTURE_FRAME_HASH_INVALID', 'visionCapture.frame.invalid') };
    }
    session.steps.push({ ...step, index: session.steps.length, pageId, action, anchor, network, frameBefore, frameAfter, ts: this.ports.now() });
    return { ok: true, value: undefined };
  }

  /** 封存：sha256 全字段绑定 + untrusted 包裹（归纳层的唯一合法输入形态） */
  seal(session: VisionCaptureSession): OperationResult<UntrustedTrace> {
    const body = {
      schemaVersion: 1 as const,
      traceId: session.traceId,
      source: session.source,
      steps: session.steps,
    };
    const sha256 = traceSha256(body);
    const validated = validateRecordedTrace({ ...body, sha256 });
    if (!validated.ok) return validated;
    return { ok: true, value: wrapUntrusted('recorded_trace', validated.value) };
  }

  /** 归纳：<untrusted_recorded_trace> → Capability Card（确定性：按 (kind×role) 分组、参数键排序提升为输入槽位、证据锚点引用步骤） */
  induceCapabilityCard(input: unknown, origin: { kind: 'site' | 'system' | 'device'; id: string }): OperationResult<CapabilityCard> {
    if (typeof input !== 'object' || input === null || (input as { tag?: unknown }).tag !== 'untrusted_recorded_trace') {
      return { ok: false, error: configError('VISION_CAPTURE_UNTRUSTED_INPUT', 'visionCapture.untrusted.required') };
    }
    const trace = (input as UntrustedTrace).payload as RecordedTrace;
    const checked = validateRecordedTrace(trace);
    if (!checked.ok) return checked;
    if (checked.value.steps.length === 0) {
      return { ok: false, error: configError('VISION_CAPTURE_EMPTY_TRACE', 'visionCapture.trace.empty') };
    }
    const groups = new Map<string, RecordedStep[]>();
    for (const step of checked.value.steps) {
      const key = `${step.action.kind}#${step.anchor?.role ?? 'none'}`;
      const list = groups.get(key) ?? [];
      list.push(step);
      groups.set(key, list);
    }
    const capabilities = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, steps]) => {
      const [kind, role] = key.split('#') as [RecordedActionKind, string];
      const slotKeys = [...new Set(steps.flatMap(step => Object.keys(step.action.params)))].sort();
      return {
        id: `${kind.replace(/-/g, '_')}_${role}`,
        description: `${kind} on ${role}`,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(slotKeys.map(slot => [slot, { type: 'string' }])),
          required: slotKeys,
        },
        outputSchema: { type: 'object', properties: { observed: { type: 'string' } } },
        preconditions: steps.some(step => step.network.length > 0)
          ? [{ kind: 'auth' as const, status: 'pending' as const }]
          : [],
        evidenceAnchors: steps.map(step => `step://${step.index}`).sort(),
      };
    });
    const body = { cardId: `card-${checked.value.traceId}`, origin, capabilities };
    const sha256 = cardSha256(body);
    const card = validateCapabilityCard({ ...body, sha256 });
    return card;
  }
}
