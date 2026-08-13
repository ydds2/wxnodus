// src/domain/build/planDag.ts — 可执行计划 DAG（计划原文）：依赖失败 → 阻塞下游（BUILD_DEPENDENCY_BLOCKED）；无进展 → 环（BUILD_DAG_CYCLE）
import type { OperationResult } from '../../protocol/results.js';
export interface PlanNode { id: string; dependsOn: string[]; run(signal: AbortSignal): Promise<OperationResult<void>> }
export interface NodeResult { status: 'passed' | 'failed' | 'blocked' | 'cancelled'; code?: string }

export async function executePlanDag(nodes: PlanNode[], signal: AbortSignal): Promise<{ nodes: Record<string, NodeResult> }> {
  const pending = new Map(nodes.map(node => [node.id, node]));
  const results: Record<string, NodeResult> = {};
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, node] of [...pending]) {
      if (node.dependsOn.some(dependency => !(dependency in results))) continue;
      progressed = true;
      pending.delete(id);
      if (signal.aborted) { results[id] = { status: 'cancelled', code: 'BUILD_ABORTED' }; continue; }
      if (node.dependsOn.some(dependency => results[dependency]?.status !== 'passed')) {
        results[id] = { status: 'blocked', code: 'BUILD_DEPENDENCY_BLOCKED' };
        continue;
      }
      const result = await node.run(signal);
      results[id] = result.ok ? { status: 'passed' } : { status: 'failed', code: result.error.code };
    }
    if (!progressed) {
      for (const id of pending.keys()) results[id] = { status: 'failed', code: 'BUILD_DAG_CYCLE' };
      break;
    }
  }
  return { nodes: results };
}
