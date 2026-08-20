// src/application/quality/buildVerifiers.ts — 构建 verifier 结果 → Run 终态投影：
// 缺 test 脚本 → incomplete/BUILD_TEST_SCRIPT_MISSING；断言失败 → failed/BUILD_VERIFIER_FAILED；崩溃 → inconclusive/BUILD_VERIFIER_INCONCLUSIVE
import type { RunFinalStatus } from '../../protocol/runs.js';

export interface BuildVerifierOutcome {
  status: 'passed' | 'failed' | 'inconclusive';
  kind?: 'test-script-missing' | 'crash' | 'assertion';
}

export interface BuildVerifierClassification { status: RunFinalStatus; code: string }

export function classifyBuildVerifierOutcome(outcome: BuildVerifierOutcome): BuildVerifierClassification {
  if (outcome.status === 'passed') return { status: 'succeeded', code: 'BUILD_VERIFIER_PASSED' };
  if (outcome.status === 'inconclusive') {
    return outcome.kind === 'test-script-missing'
      ? { status: 'incomplete', code: 'BUILD_TEST_SCRIPT_MISSING' }
      : { status: 'inconclusive', code: 'BUILD_VERIFIER_INCONCLUSIVE' };
  }
  return { status: 'failed', code: 'BUILD_VERIFIER_FAILED' };
}

export function buildVerifierDecision(outcomes: BuildVerifierOutcome[]): BuildVerifierClassification {
  const classifications = outcomes.map(classifyBuildVerifierOutcome);
  if (classifications.some(item => item.status === 'failed')) return { status: 'failed', code: 'BUILD_VERIFIER_FAILED' };
  if (classifications.some(item => item.status === 'incomplete')) return { status: 'incomplete', code: 'BUILD_TEST_SCRIPT_MISSING' };
  if (classifications.some(item => item.status === 'inconclusive')) return { status: 'inconclusive', code: 'BUILD_VERIFIER_INCONCLUSIVE' };
  return { status: 'succeeded', code: 'BUILD_VERIFIER_PASSED' };
}
