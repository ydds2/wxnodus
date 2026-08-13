// src/application/build/adversarialProbe.ts — 对抗探针 + held-out 变体回放（§10-2 完整集成）：
// 对可执行计划注入 held-out 变体并重放，验证验收管线对每类变体给出确定性终局：
//   基线必须全 passed；变体必须命中预期失败码（依赖阻塞/环/输出漂移/中止）
// 若变体意外通过（管线漏检）→ 探针整体失败 PROBE_VARIANT_UNEXPECTED（绝不静默通过）
import type { OperationResult } from '../../protocol/results.js';
import { executePlanDag, type PlanNode } from '../../domain/build/planDag.js';

export interface ProbeCase {
  id: string;
  plan: PlanNode[];
  expect: 'passed' | { code: string };
}

export interface ProbeReport {
  caseId: string;
  expected: 'passed' | string;
  observed: 'passed' | string;
  status: 'passed' | 'unexpected';
  detail?: string;
}

export class AdversarialProbe {
  /** 单个变体重放：终局判定 = 计划末节点（验收闸门）状态 */
  async assess(probeCase: ProbeCase, signal: AbortSignal): Promise<ProbeReport> {
    if (probeCase.plan.length === 0) {
      return {
        caseId: probeCase.id,
        expected: typeof probeCase.expect === 'string' ? probeCase.expect : 'passed',
        observed: 'PROBE_PLAN_EMPTY',
        status: 'unexpected',
        detail: 'empty plan cannot be assessed',
      };
    }
    const { nodes } = await executePlanDag(probeCase.plan, signal);
    const terminal = nodes[probeCase.plan[probeCase.plan.length - 1].id];
    const observed = terminal?.status === 'passed' ? 'passed' : (terminal?.code ?? terminal?.status ?? 'PROBE_NO_VERDICT');
    const expected = typeof probeCase.expect === 'string' ? probeCase.expect : probeCase.expect.code;
    const matches = observed === expected;
    return {
      caseId: probeCase.id,
      expected,
      observed,
      status: matches ? 'passed' : 'unexpected',
      detail: matches ? undefined : `expected ${expected}, observed ${observed}`,
    };
  }

  /** 全量变体回放：任一 case 意外（含漏检通过）→ 探针失败并携带全部报告 */
  async run(cases: ProbeCase[], signal: AbortSignal): Promise<OperationResult<ProbeReport[]>> {
    const reports: ProbeReport[] = [];
    for (const probeCase of cases) {
      reports.push(await this.assess(probeCase, signal));
    }
    const unexpected = reports.filter(report => report.status !== 'passed');
    if (unexpected.length > 0) {
      return {
        ok: false,
        error: {
          code: 'PROBE_VARIANT_UNEXPECTED',
          message: 'Adversarial probe: acceptance pipeline behaved unexpectedly on held-out variants',
          messageKey: 'PROBE_VARIANT_UNEXPECTED',
          retryable: false,
          details: { unexpected: unexpected.map(report => ({ caseId: report.caseId, expected: report.expected, observed: report.observed })) },
        },
      };
    }
    return { ok: true, value: reports };
  }
}
