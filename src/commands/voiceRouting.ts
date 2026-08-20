// src/commands/voiceRouting.ts — Wave 3 Voice 第 1 步：语音能力组合路由决策
// modern/required 请求在 kernel/TUI voice 降为 facade（VoiceSessionService 全入口接管）完成前
// fail-closed（VOICE_MODERN_UNAVAILABLE）——绝不静默退回 legacy 假成功；legacy/shadow 走现有链路。
// 与 buildRouting 同构：显式 capability 声明 > 根路由。
import {
  resolveCompositionRouting,
  type CompositionRoutingSnapshot,
} from '../bootstrap/compositionRouting.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

export type VoiceCapabilityRoute = 'legacy' | 'modern';

export interface VoiceRouteDecision {
  route: VoiceCapabilityRoute;
  snapshot: CompositionRoutingSnapshot;
  reason: string;
}

// kernel/TUI voice 已降为 facade：转写执行/状态机/产物落盘全部委托 VoiceSessionService（kernel 仅保留采集/设备/TTS 适配面）
const VOICE_FACADE_DONE = true;

export function decideVoiceRoute(input: {
  operatorFlag?: string;
  env?: string;
}): OperationResult<VoiceRouteDecision> {
  const snapshot = resolveCompositionRouting({ operatorFlag: input.operatorFlag, env: input.env });
  if (!snapshot.ok) return snapshot;
  const declared = snapshot.value.capability['voice'];
  const route: VoiceCapabilityRoute =
    declared === 'modern' || declared === 'required'
      ? 'modern'
      : declared === 'shadow' || declared === 'legacy'
        ? 'legacy'
        : snapshot.value.root === 'modern'
          ? 'modern'
          : 'legacy';
  if (route === 'modern' && !VOICE_FACADE_DONE) {
    return err(
      gatewayError(
        'VOICE_MODERN_UNAVAILABLE',
        'voice 能力的 modern 路由不可用',
        'voice.modern.unavailable',
      ),
    );
  }
  return ok({ route, snapshot: snapshot.value, reason: `composition-root:${snapshot.value.root}` });
}
