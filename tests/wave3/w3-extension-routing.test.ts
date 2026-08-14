// tests/wave3/w3-extension-routing.test.ts — Wave 3 Plugin/Subagent/MCP 第 1 步：组合路由决策（fail-closed）
import { describe, expect, it } from 'vitest';
import { decideMcpRoute, decidePluginRoute, decideSubagentRoute } from '../../src/commands/extensionRouting.js';

describe('extension capability routing', () => {
  it('plugin defaults to legacy and routes to the wired lifecycle on modern', () => {
    const legacy = decidePluginRoute({});
    const modern = decidePluginRoute({ operatorFlag: 'modern' });
    expect(legacy.ok && legacy.value.route).toBe('legacy');
    expect(modern.ok).toBe(true);
    if (!modern.ok) throw new Error('unreachable');
    expect(modern.value.route).toBe('modern');
  });

  it('subagent defaults to legacy and fails closed on modern', () => {
    const legacy = decideSubagentRoute({});
    const modern = decideSubagentRoute({ env: 'modern' });
    expect(legacy.ok && legacy.value.route).toBe('legacy');
    expect(modern.ok).toBe(false);
    if (modern.ok) throw new Error('unreachable');
    expect(modern.error.code).toBe('SUBAGENT_MODERN_UNAVAILABLE');
  });

  it('mcp defaults to legacy and fails closed on modern', () => {
    const legacy = decideMcpRoute({});
    const modern = decideMcpRoute({ operatorFlag: 'modern' });
    expect(legacy.ok && legacy.value.route).toBe('legacy');
    expect(modern.ok).toBe(false);
    if (modern.ok) throw new Error('unreachable');
    expect(modern.error.code).toBe('MCP_MODERN_UNAVAILABLE');
  });

  it('shadow stays on legacy for all three', () => {
    for (const decide of [decidePluginRoute, decideSubagentRoute, decideMcpRoute]) {
      const decision = decide({ env: 'shadow' });
      expect(decision.ok && decision.value.route).toBe('legacy');
    }
  });

  it('invalid roots propagate', () => {
    const decision = decidePluginRoute({ operatorFlag: 'banana' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.error.code).toBe('COMPOSITION_ROOT_INVALID');
  });
});
