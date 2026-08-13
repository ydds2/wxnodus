// tests/release-gate-runner.test.ts — Wave 0 scope 正测：A/B/C/F required，D/E/G/H/I N/A
import { describe, expect, it } from 'vitest';
import { WAVE_0_SCOPE, WAVE_0_RUNNERS, WAVE_0_UNREACHABLE } from '../src/release/gateDefinitions.js';

describe('Wave 0 gate scope', () => {
  it('A 只含 build + typecheck', () => {
    expect(WAVE_0_SCOPE.A).toEqual({ mode: 'required', runnerIds: ['build', 'typecheck'] });
    expect(WAVE_0_RUNNERS.build.args).toEqual(['run', 'build']);
    expect(WAVE_0_RUNNERS.typecheck.args).toEqual(['run', 'typecheck']);
  });

  it('B 为基线闭包（discovery + test:all + known-failures）', () => {
    expect(WAVE_0_SCOPE.B).toEqual({ mode: 'required', runnerIds: ['test-discovery', 'test-all', 'known-failures'] });
  });

  it('C required 且 F 仅 policy scope', () => {
    expect(WAVE_0_SCOPE.C.mode).toBe('required');
    expect(WAVE_0_SCOPE.F).toEqual({ mode: 'required', runnerIds: ['policy-manifest-check', 'policy-fixture-tests'] });
  });

  it('D/E/G/H/I 严格 N/A 且 unreachable ID 非空', () => {
    for (const gate of ['D', 'E', 'G', 'H', 'I'] as const) {
      expect(WAVE_0_SCOPE[gate]).toEqual({ mode: 'na', reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE' });
      expect(WAVE_0_UNREACHABLE[gate].length).toBeGreaterThan(0);
    }
  });

  it('所有 required runner 都有可执行命令定义', () => {
    for (const [gate, scope] of Object.entries(WAVE_0_SCOPE)) {
      if (scope.mode === 'required') {
        for (const runnerId of scope.runnerIds) {
          expect(WAVE_0_RUNNERS[runnerId], `${gate}:${runnerId}`).toBeDefined();
          expect(WAVE_0_RUNNERS[runnerId]!.args.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
