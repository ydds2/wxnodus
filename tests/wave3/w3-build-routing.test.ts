// tests/wave3/w3-build-routing.test.ts — Wave 3 Build 第 1 步：组合路由决策（fail-closed，不假成功）
import { describe, expect, it } from 'vitest';
import { decideBuildRoute } from '../../src/commands/buildRouting.js';

describe('build capability routing', () => {
  it('defaults to the legacy pipeline (现状不破坏)', () => {
    const decision = decideBuildRoute({});
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('legacy');
    expect(decision.value.snapshot.root).toBe('legacy');
  });

  it('shadow root still runs the legacy pipeline without double execution', () => {
    const decision = decideBuildRoute({ env: 'shadow' });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('legacy');
  });

  it('modern root routes to the wired BuildService pipeline', () => {
    const decision = decideBuildRoute({ operatorFlag: 'modern' });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('modern');
  });

  it('env modern routes identically', () => {
    const decision = decideBuildRoute({ env: 'modern' });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('modern');
  });

  it('propagates invalid composition roots instead of guessing', () => {
    const decision = decideBuildRoute({ operatorFlag: 'banana' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('COMPOSITION_ROOT_INVALID');
  });
});
