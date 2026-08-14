// tests/wave3/w3-computer-routing.test.ts — Wave 3 Computer/Browser 第 1 步：组合路由决策（fail-closed）
import { describe, expect, it } from 'vitest';
import { decideBrowserRoute, decideComputerRoute } from '../../src/commands/computerRouting.js';

describe('computer/browser capability routing', () => {
  it('defaults to the legacy computer pipeline', () => {
    const decision = decideComputerRoute({});
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.value.route).toBe('legacy');
  });

  it('modern computer root fails closed with COMPUTER_MODERN_UNAVAILABLE', () => {
    const decision = decideComputerRoute({ operatorFlag: 'modern' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('COMPUTER_MODERN_UNAVAILABLE');
  });

  it('modern browser root fails closed with BROWSER_MODERN_UNAVAILABLE', () => {
    const decision = decideBrowserRoute({ env: 'modern' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('BROWSER_MODERN_UNAVAILABLE');
  });

  it('browser legacy/shadow stays on the legacy pipeline', () => {
    const legacy = decideBrowserRoute({});
    const shadow = decideBrowserRoute({ env: 'shadow' });
    expect(legacy.ok && legacy.value.route).toBe('legacy');
    expect(shadow.ok && shadow.value.route).toBe('legacy');
  });

  it('invalid roots propagate', () => {
    const decision = decideComputerRoute({ operatorFlag: 'banana' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('COMPOSITION_ROOT_INVALID');
  });
});
