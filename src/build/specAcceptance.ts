// src/build/specAcceptance.ts — W3 Build 契约：spec → 结构化验收标准（BuildService 的唯一入口适配）
// 模具的产物结构是确定性的（scaffold 生成 server/index.js + healthcheck.js）——
// 逐条映射为可验证 criteria（file.exists verifier + 启动验证节点真实执行）；
// 未知模具 → BUILD_ACCEPTANCE_UNSPECIFIED fail-closed（无结构化验收不可现代编译，
// 绝不把自然语言 acceptance 伪装成可验证断言）。
import type { AcceptanceCriterion } from '../domain/build/acceptance.js';
import type { OperationResult } from '../protocol/results.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

/** 模具 → 确定性产物锚点（scaffold 契约：每个模具都生成 server 入口 + healthcheck） */
const SCAFFOLD_ANCHORS: Record<string, string[]> = {
  ledger: ['server/index.js', 'healthcheck.js'],
  todo: ['server/index.js', 'healthcheck.js'],
  note: ['server/index.js', 'healthcheck.js'],
  anim: ['server/index.js', 'healthcheck.js'],
  generic: ['server/index.js', 'healthcheck.js'],
};

export function specToAcceptance(spec: unknown): OperationResult<AcceptanceCriterion[]> {
  const value = spec as { scaffold?: unknown; title?: unknown; acceptance?: unknown };
  const scaffold = typeof value?.scaffold === 'string' ? value.scaffold : '';
  const anchors = SCAFFOLD_ANCHORS[scaffold];
  if (!anchors) {
    return fail('BUILD_ACCEPTANCE_UNSPECIFIED', { scaffold });
  }
  const title = typeof value.title === 'string' && value.title ? value.title : '构建产物';
  const criteria: AcceptanceCriterion[] = anchors.map((path, index) => ({
    id: `scaffold-${index + 1}`,
    required: true,
    description: `${title}：产物 ${path} 生成`,
    verifierId: 'file.exists',
    expected: { path },
    evidenceRequirements: [`file:${path}`],
  }));
  return { ok: true, value: criteria };
}
