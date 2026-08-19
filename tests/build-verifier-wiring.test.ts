// tests/build-verifier-wiring.test.ts — 阶段 3：buildVerifiers 接入生产完成判定的投影等价契约
import { describe, it, expect } from 'vitest';
import { projectCompletionOutcome } from '../src/application/build/buildServiceWiring.js';

describe('projectCompletionOutcome（buildVerifiers 单一事实源生产接入点）', () => {
  it('全部 passed → BUILD_VERIFIER_PASSED / outcome passed', () => {
    const r = projectCompletionOutcome(['passed', 'passed']);
    expect(r.outcome).toBe('passed');
    expect(r.code).toBe('BUILD_VERIFIER_PASSED');
  });

  it('任一 failed 优先 → BUILD_VERIFIER_FAILED', () => {
    const r = projectCompletionOutcome(['passed', 'failed', 'passed']);
    expect(r.outcome).toBe('failed');
    expect(r.code).toBe('BUILD_VERIFIER_FAILED');
  });

  it('无 failed 但有 skipped → BUILD_VERIFIER_INCONCLUSIVE（与旧三目行为等价）', () => {
    const r = projectCompletionOutcome(['passed', 'skipped']);
    expect(r.outcome).toBe('inconclusive');
    expect(r.code).toBe('BUILD_VERIFIER_INCONCLUSIVE');
  });

  it('空状态集 → passed（全称量词空真，与旧 every 语义等价）', () => {
    const r = projectCompletionOutcome([]);
    expect(r.outcome).toBe('passed');
  });
});
