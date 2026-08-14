// tests/wave3/w3-voice-routing.test.ts — Wave 3 Voice 第 1 步：组合路由决策（fail-closed，不假成功）
import { describe, expect, it } from 'vitest';
import { decideVoiceRoute } from '../../src/commands/voiceRouting.js';

describe('voice capability routing', () => {
  it('defaults to the legacy voice pipeline (现状不破坏)', () => {
    const decision = decideVoiceRoute({});
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('legacy');
    expect(decision.value.snapshot.root).toBe('legacy');
  });

  it('shadow root still runs the legacy pipeline without double execution', () => {
    const decision = decideVoiceRoute({ env: 'shadow' });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('legacy');
  });

  it('modern root routes to the facade-backed modern path (kernel voice is a VoiceSessionService adapter)', () => {
    const decision = decideVoiceRoute({ operatorFlag: 'modern' });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('modern');
  });

  it('env modern routes identically', () => {
    const decision = decideVoiceRoute({ env: 'modern' });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('modern');
  });

  it('propagates invalid composition roots instead of guessing', () => {
    const decision = decideVoiceRoute({ operatorFlag: 'banana' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('COMPOSITION_ROOT_INVALID');
  });
});
