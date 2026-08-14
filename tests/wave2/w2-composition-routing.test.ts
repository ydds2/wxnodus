// tests/wave2/w2-composition-routing.test.ts — W2-01：不可变组合路由快照
// operator 可用 --composition-root/WXNODUS_COMPOSITION_ROOT 指定；workspace 不得降级 modern/deny；
// 未知值稳定拒绝；默认保持 legacy（不破坏现有生产入口）。
import { describe, expect, it } from 'vitest';
import { resolveCapabilityRoute, resolveCompositionRouting } from '../../src/bootstrap/compositionRouting.js';

describe('composition routing snapshot', () => {
  it('defaults to the legacy root when nothing is declared', () => {
    const result = resolveCompositionRouting({});
    expect(result).toMatchObject({ ok: true, value: { root: 'legacy', source: 'default' } });
  });

  it('honours the operator flag over the environment and default', () => {
    const result = resolveCompositionRouting({ operatorFlag: 'modern', env: 'shadow' });
    expect(result).toMatchObject({ ok: true, value: { root: 'modern', source: 'operator-flag' } });
    const envOnly = resolveCompositionRouting({ env: 'shadow' });
    expect(envOnly).toMatchObject({ ok: true, value: { root: 'shadow', source: 'env' } });
  });

  it.each(['nonsense', 'MODERN', ''])('rejects an invalid composition root %s', value => {
    expect(resolveCompositionRouting({ operatorFlag: value })).toMatchObject({
      ok: false,
      error: { code: 'COMPOSITION_ROOT_INVALID' },
    });
  });

  it('never lets the operator downgrade a workspace-declared modern root', () => {
    const result = resolveCompositionRouting({ operatorFlag: 'legacy', workspace: { root: 'modern' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'COMPOSITION_ROOT_DOWNGRADE_DENIED' } });
  });

  it('carries workspace capability routing into the snapshot', () => {
    const result = resolveCompositionRouting({
      workspace: { root: 'shadow', capability: { memory: 'modern', browser: 'shadow' } },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { root: 'shadow', source: 'workspace', capability: { memory: 'modern', browser: 'shadow' } },
    });
  });

  it('rejects downgrading a required capability to legacy or shadow', () => {
    const result = resolveCompositionRouting({
      operatorFlag: 'modern',
      workspace: { capability: { build: 'required' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    // required 能力快照保持不变，任何后续降级判定由 resolveCapabilityRoute 把关
    expect(result.value.capability.build).toBe('required');
    expect(resolveCapabilityRoute(result.value, 'build', 'legacy')).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_ROUTE_DOWNGRADE_DENIED' },
    });
    expect(resolveCapabilityRoute(result.value, 'build', 'modern')).toMatchObject({ ok: true });
  });

  it('rejects an unknown capability route value in workspace config', () => {
    expect(resolveCompositionRouting({
      workspace: { capability: { memory: 'bogus' as never } },
    })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_ROUTE_INVALID' } });
  });

  it('falls back to the root route for undeclared capabilities', () => {
    const result = resolveCompositionRouting({ operatorFlag: 'modern' });
    if (!result.ok) throw new Error(result.error.code);
    expect(resolveCapabilityRoute(result.value, 'browser', 'modern')).toMatchObject({ ok: true });
  });
});
