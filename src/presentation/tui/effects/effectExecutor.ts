// src/presentation/tui/effects/effectExecutor.ts — 副作用执行器：唯一允许触碰 GatewayPort 的展示层组件
import type { GatewayPort } from '../../../protocol/gateway.js';
import type { OperationResult } from '../../../protocol/results.js';
import type { TuiEffect } from '../state/reducer.js';

export class TuiEffectExecutor {
  constructor(private readonly gateway: GatewayPort) {}

  async execute(effect: TuiEffect, signal: AbortSignal): Promise<OperationResult<void>> {
    if (effect.type !== 'gateway.request') return {
      ok: false,
      error: { code: 'TUI_EFFECT_UNSUPPORTED', message: effect.effectType, messageKey: 'TUI_EFFECT_UNSUPPORTED', retryable: false },
    };
    try {
      const result = await this.gateway.request(effect.method, effect.params, { signal, correlationId: effect.correlationId });
      return result.ok ? { ok: true, value: undefined, evidenceIds: result.evidenceIds } : result;
    } catch {
      return {
        ok: false,
        error: { code: 'TUI_EFFECT_FAILED', message: effect.method, messageKey: 'TUI_EFFECT_FAILED', retryable: false },
      };
    }
  }
}
