// tests/vision-capture-negotiator.contract.test.ts — 蓝图三内核剩余两块的最小可验证契约：
// VisionCapture：轨迹录制 → seal（sha256 绑定）→ <untrusted_recorded_trace> 隔离（归纳层拒绝裸输入）→ Capability Card 确定性归纳
// CompatNegotiator：字段映射机器门三规则 + EARS 主观词禁令 + spec 冻结哈希/漂移检测
import { describe, expect, it } from 'vitest';
import { VisionCaptureService } from '../src/application/computer/visionCaptureService.js';
import { CompatNegotiatorService } from '../src/application/computer/compatNegotiatorService.js';
import {
  freezeCompatSpec, validateEarsAcceptance, validateFieldMapping, verifyCompatSpec, REGISTERED_TRANSFORMS,
} from '../src/domain/computer/compatNegotiation.js';
import { isUntrustedWrapper, validateCapabilityCard, validateRecordedTrace } from '../src/domain/computer/visionCapture.js';

const now = () => '2026-08-13T00:00:00.000Z';
const frame = (seed: string) => ({ sha256: seed.repeat(64).slice(0, 64), bytes: 1024 });

describe('VisionCapture 录制层', () => {
  it('records steps, seals with sha256 binding, and wraps into <untrusted_recorded_trace>', () => {
    const service = new VisionCaptureService({ now });
    const session = service.openSession('trace-1', 'browser');
    expect(service.recordStep(session, {
      pageId: 'p1',
      action: { kind: 'click', params: { x: '10', y: '20' } },
      anchor: { role: 'button', name: '提交', path: ['main', 'form'] },
      frameBefore: frame('a'),
      frameAfter: frame('b'),
      network: [{ method: 'POST', url: 'https://example.com/api/order', status: 200 }],
    })).toMatchObject({ ok: true });
    const sealed = service.seal(session);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.value.tag).toBe('untrusted_recorded_trace');
    expect(isUntrustedWrapper(sealed.value, 'recorded_trace')).toBe(true);
    expect(validateRecordedTrace(sealed.value.payload)).toMatchObject({ ok: true });
  });

  it('rejects steps without frame pairs (visual triple is mandatory)', () => {
    const service = new VisionCaptureService({ now });
    const session = service.openSession('trace-2', 'uia');
    expect(service.recordStep(session, {
      pageId: 'p1',
      action: { kind: 'invoke', params: {} },
      anchor: { role: 'button', name: 'x', path: ['w'] },
      frameBefore: null,
      frameAfter: null,
      network: [],
    })).toMatchObject({ ok: false, error: { code: 'VISION_CAPTURE_FRAME_HASH_INVALID' } });
  });

  it('induces a deterministic Capability Card only from the untrusted wrapper', () => {
    const service = new VisionCaptureService({ now });
    const build = () => {
      const session = service.openSession('trace-3', 'browser');
      service.recordStep(session, {
        pageId: 'p1', action: { kind: 'click', params: { sku: 'A1' } },
        anchor: { role: 'button', name: 'buy', path: ['main'] }, frameBefore: frame('a'), frameAfter: frame('b'),
        network: [{ method: 'POST', url: 'https://example.com/buy', status: 200 }],
      });
      service.recordStep(session, {
        pageId: 'p1', action: { kind: 'click', params: { sku: 'A2' } },
        anchor: { role: 'button', name: 'buy', path: ['main'] }, frameBefore: frame('c'), frameAfter: frame('d'),
        network: [{ method: 'POST', url: 'https://example.com/buy', status: 200 }],
      });
      service.recordStep(session, {
        pageId: 'p1', action: { kind: 'type', params: { text: 'x' } },
        anchor: { role: 'textbox', name: 'search', path: ['main'] }, frameBefore: frame('e'), frameAfter: frame('f'), network: [],
      });
      return service.seal(session);
    };
    const first = build();
    const second = build();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // 归纳层拒绝裸输入（未包裹 trace → VISION_CAPTURE_UNTRUSTED_INPUT）
    expect(service.induceCapabilityCard(first.value.payload, { kind: 'site', id: 'example.com' })).toMatchObject({
      ok: false, error: { code: 'VISION_CAPTURE_UNTRUSTED_INPUT' },
    });
    const cardA = service.induceCapabilityCard(first.value, { kind: 'site', id: 'example.com' });
    const cardB = service.induceCapabilityCard(second.value, { kind: 'site', id: 'example.com' });
    expect(cardA.ok && cardB.ok).toBe(true);
    if (!cardA.ok || !cardB.ok) return;
    // 确定性：同轨迹 → 同卡片（sha256 相同）
    expect(cardA.value).toEqual(cardB.value);
    expect(validateCapabilityCard(cardA.value)).toMatchObject({ ok: true });
    // 归纳分组：(click×button) + (type×textbox)；槽位从参数键提升；网络动作携带 auth pending 前置
    expect(cardA.value.capabilities.map(cap => cap.id).sort()).toEqual(['click_button', 'type_textbox']);
    const clickCap = cardA.value.capabilities.find(cap => cap.id === 'click_button')!;
    expect(clickCap.inputSchema.required).toEqual(['sku']);
    expect(clickCap.evidenceAnchors).toEqual(['step://0', 'step://1']);
    expect(clickCap.preconditions).toEqual([{ kind: 'auth', status: 'pending' }]);
  });

  it('rejects empty traces at induction', () => {
    const service = new VisionCaptureService({ now });
    const sealed = service.seal(service.openSession('trace-empty', 'browser'));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(service.induceCapabilityCard(sealed.value, { kind: 'site', id: 'x' })).toMatchObject({
      ok: false, error: { code: 'VISION_CAPTURE_EMPTY_TRACE' },
    });
  });
});

describe('CompatNegotiator 字段映射机器门 + spec 冻结', () => {
  const card = (id: string, caps: Array<{ input?: string[]; output?: string[] }>) => ({
    cardId: id,
    origin: { kind: 'site' as const, id: id },
    capabilities: caps.map((cap, index) => ({
      id: `${id}_cap_${index}`,
      description: `capability ${index}`,
      inputSchema: { type: 'object', properties: Object.fromEntries((cap.input ?? []).map(key => [key, { type: 'string' }])) },
      outputSchema: { type: 'object', properties: Object.fromEntries((cap.output ?? []).map(key => [key, { type: 'string' }])) },
      preconditions: [],
      evidenceAnchors: [`har://${id}_${index}`],
    })),
    sha256: '0'.repeat(64),
  });
  const source = card('source-1', [{ output: ['buyer_name', 'amount_fen'] }]);
  const target = card('target-1', [{ input: ['customer_name', 'total_spent'] }]);

  it('machine gate enforces source existence, target existence, and registered transforms', () => {
    expect(validateFieldMapping({ from: 'buyer_name', to: 'customer_name', transform: 'trim' }, source, target)).toMatchObject({ ok: true });
    expect(validateFieldMapping({ from: 'not_in_source', to: 'customer_name', transform: 'trim' }, source, target)).toMatchObject({
      ok: false, error: { code: 'NEGOTIATION_MAPPING_SOURCE_MISSING' },
    });
    expect(validateFieldMapping({ from: 'buyer_name', to: 'not_in_target', transform: 'trim' }, source, target)).toMatchObject({
      ok: false, error: { code: 'NEGOTIATION_MAPPING_TARGET_MISSING' },
    });
    // 自由文本转换描述被拒绝（只能注册函数集）
    expect(validateFieldMapping({ from: 'buyer_name', to: 'customer_name', transform: 'remove_middle_name' as never }, source, target)).toMatchObject({
      ok: false, error: { code: 'NEGOTIATION_MAPPING_TRANSFORM_UNKNOWN' },
    });
    expect(REGISTERED_TRANSFORMS).toContain('divide_100');
  });

  it('rejects subjective EARS acceptance and freezes an objective spec hash', () => {
    expect(validateEarsAcceptance(['当源侧新增订单时，目标系统 90 分钟内出现对应客户记录'])).toMatchObject({ ok: true });
    expect(validateEarsAcceptance(['尽快同步数据'])).toMatchObject({
      ok: false, error: { code: 'NEGOTIATION_ACCEPTANCE_NOT_OBJECTIVE' },
    });
    expect(validateEarsAcceptance([])).toMatchObject({ ok: false, error: { code: 'NEGOTIATION_ACCEPTANCE_NOT_OBJECTIVE' } });
    const frozen = freezeCompatSpec({
      specId: 'cs_订单同步_001',
      intent: '把 A 站订单同步到 B 系统客户表',
      parties: { sourceCardId: 'source-1', targetCardId: 'target-1' },
      fieldMappings: [{ from: 'buyer_name', to: 'customer_name', transform: 'trim' }],
      orchestration: { direction: 'one_way', trigger: { type: 'poll', intervalSec: 3600 } },
      acceptance: ['当源侧新增一条订单时，目标系统 90 分钟内出现对应客户记录且金额字段一致'],
      compliance: { channelClass: 'P2' },
    });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.value.specHash).toMatch(/^[a-f0-9]{12}$/);
    expect(verifyCompatSpec(frozen.value)).toMatchObject({ ok: true });
    // 冻结后漂移（改一个映射）→ NEGOTIATION_SPEC_DRIFT
    const drifted = { ...frozen.value, fieldMappings: [{ from: 'amount_fen', to: 'total_spent', transform: 'divide_100' as const }] };
    expect(verifyCompatSpec(drifted)).toMatchObject({ ok: false, error: { code: 'NEGOTIATION_SPEC_DRIFT' } });
  });

  it('negotiates end-to-end through the service and blocks fabricated mappings before freezing', async () => {
    const service = new CompatNegotiatorService({ sourceCard: async () => ({ ok: true, value: source }), targetCard: async () => ({ ok: true, value: target }) });
    const draft = {
      specId: 'cs-e2e', intent: 'sync orders',
      parties: { sourceCardId: 'source-1', targetCardId: 'target-1' },
      fieldMappings: [{ from: 'buyer_name', to: 'customer_name', transform: 'trim' as const }],
      orchestration: { direction: 'one_way' as const, trigger: { type: 'poll' as const, intervalSec: 60 } },
      acceptance: ['当源侧新增订单时，目标系统 60 分钟内出现对应记录'],
      compliance: { channelClass: 'P2' as const },
    };
    const ok = await service.negotiate(draft);
    expect(ok).toMatchObject({ ok: true, value: { specHash: expect.stringMatching(/^[a-f0-9]{12}$/) } });
    const fabricated = await service.negotiate({ ...draft, fieldMappings: [{ from: 'invented_field', to: 'customer_name', transform: 'trim' as const }] });
    expect(fabricated).toMatchObject({ ok: false, error: { code: 'NEGOTIATION_MAPPING_SOURCE_MISSING' } });
  });
});
