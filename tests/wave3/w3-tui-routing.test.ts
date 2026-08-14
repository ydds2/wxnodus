// tests/wave3/w3-tui-routing.test.ts — Wave 3 TUI 第 1 步：装配组合路由决策（fail-closed）
import { describe, expect, it } from 'vitest';
import { decideTuiRoute } from '../../src/bootstrap/tuiRouting.js';

describe('tui capability routing', () => {
  it('defaults to the legacy TUI assembly', () => {
    const decision = decideTuiRoute({});
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('legacy');
    expect(decision.value.snapshot.root).toBe('legacy');
  });

  it('shadow root still assembles the legacy TUI', () => {
    const decision = decideTuiRoute({ env: 'shadow' });
    expect(decision.ok && decision.value.route).toBe('legacy');
  });

  it('modern root fails closed with TUI_MODERN_UNAVAILABLE', () => {
    const decision = decideTuiRoute({ operatorFlag: 'modern' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('TUI_MODERN_UNAVAILABLE');
  });

  it('env modern is equally denied', () => {
    const decision = decideTuiRoute({ env: 'modern' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('TUI_MODERN_UNAVAILABLE');
  });

  it('propagates invalid roots', () => {
    const decision = decideTuiRoute({ operatorFlag: 'banana' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('COMPOSITION_ROOT_INVALID');
  });
});
