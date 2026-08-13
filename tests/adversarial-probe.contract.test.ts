// tests/adversarial-probe.contract.test.ts — §10-2：对抗探针 + held-out 变体回放的确定性合同
import { describe, expect, it } from 'vitest';
import { AdversarialProbe } from '../src/application/build/adversarialProbe.js';
import type { PlanNode } from '../src/domain/build/planDag.js';
import type { OperationResult } from '../src/protocol/results.js';

const okResult = async (): Promise<OperationResult<void>> => ({ ok: true, value: undefined });
const failResult = (code: string): OperationResult<void> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

interface FixtureConfig { lintBroken: boolean; outputDrift: boolean; cyclic: boolean }

/** 夹具计划：lint → compile → verify（终局闸门）；cyclic 时 a⇄b 成环 */
const makePlan = (config: FixtureConfig): PlanNode[] => {
  if (config.cyclic) {
    return [
      { id: 'a', dependsOn: ['b'], run: okResult },
      { id: 'b', dependsOn: ['a'], run: okResult },
    ];
  }
  return [
    { id: 'lint', dependsOn: [], run: () => (config.lintBroken ? Promise.resolve(failResult('BUILD_LINT_FAILED')) : okResult()) },
    { id: 'compile', dependsOn: ['lint'], run: okResult },
    { id: 'verify', dependsOn: ['compile'], run: () => (config.outputDrift ? Promise.resolve(failResult('BUILD_OUTPUT_DRIFT')) : okResult()) },
  ];
};

const canonical = (): FixtureConfig => ({ lintBroken: false, outputDrift: false, cyclic: false });

describe('对抗探针（AdversarialProbe）', () => {
  it('基线重放全 passed；held-out 变体全部命中预期失败码 → 探针通过', async () => {
    const probe = new AdversarialProbe();
    const result = await probe.run([
      { id: 'baseline', plan: makePlan(canonical()), expect: 'passed' },
      { id: 'heldout-lint-broken', plan: makePlan({ ...canonical(), lintBroken: true }), expect: { code: 'BUILD_DEPENDENCY_BLOCKED' } },
      { id: 'heldout-output-drift', plan: makePlan({ ...canonical(), outputDrift: true }), expect: { code: 'BUILD_OUTPUT_DRIFT' } },
      { id: 'heldout-cycle', plan: makePlan({ ...canonical(), cyclic: true }), expect: { code: 'BUILD_DAG_CYCLE' } },
    ], new AbortController().signal);
    expect(result.ok).toBe(true);
  });

  it('中止信号：终局判定 BUILD_ABORTED（不当作 passed）', async () => {
    const probe = new AdversarialProbe();
    const aborted = new AbortController();
    aborted.abort();
    const report = await probe.assess({ id: 'abort-case', plan: makePlan(canonical()), expect: { code: 'BUILD_ABORTED' } }, aborted.signal);
    expect(report).toMatchObject({ caseId: 'abort-case', observed: 'BUILD_ABORTED', status: 'passed' });
  });

  it('管线漏检（held-out 变体意外通过/错误码不符）→ 探针整体失败 PROBE_VARIANT_UNEXPECTED，绝不静默', async () => {
    const probe = new AdversarialProbe();
    const result = await probe.run([
      { id: 'baseline', plan: makePlan(canonical()), expect: 'passed' },
      // 陷阱：输出漂移变体却宣称应通过——管线若漏检，探针必须亮红
      { id: 'trap-drift-missed', plan: makePlan({ ...canonical(), outputDrift: true }), expect: 'passed' },
    ], new AbortController().signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROBE_VARIANT_UNEXPECTED');
    const details = result.error.details as { unexpected: Array<{ caseId: string; observed: string }> };
    expect(details.unexpected.map(item => item.caseId)).toContain('trap-drift-missed');
    expect(details.unexpected.find(item => item.caseId === 'trap-drift-missed')?.observed).toBe('BUILD_OUTPUT_DRIFT');
  });

  it('空计划不产生伪终局：PROBE_PLAN_EMPTY 计入意外', async () => {
    const probe = new AdversarialProbe();
    const report = await probe.assess({ id: 'empty', plan: [], expect: 'passed' }, new AbortController().signal);
    expect(report).toMatchObject({ status: 'unexpected', observed: 'PROBE_PLAN_EMPTY' });
  });
});
