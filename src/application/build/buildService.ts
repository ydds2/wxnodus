// src/application/build/buildService.ts — Acceptance-driven BuildService：staging 事务 + 严格验收 + 单一 DAG + 原子换入
// 全部入口（CLI 命令/工具/MCP/HTTP）委托这唯一服务；开放域请求永不伪造完成（BUILD_OPEN_DOMAIN_UNSUPPORTED）
import type { AcceptanceCriterion } from '../../domain/build/acceptance.js';
import { validateAcceptance } from '../../domain/build/acceptance.js';
import type { BuildVerificationSnapshot } from '../../domain/build/buildRun.js';
import { assertSnapshotMatch, createBuildVerificationSnapshot } from '../../domain/build/buildRun.js';
import type { NodeResult, PlanNode } from '../../domain/build/planDag.js';
import { executePlanDag } from '../../domain/build/planDag.js';
import type { OperationResult } from '../../protocol/results.js';
import type { RunFinalStatus } from '../../protocol/runs.js';
import { CompletionCoordinator } from '../quality/completionCoordinator.js';
import type { CompletionGateInput } from '../../domain/quality/completionGate.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface BuildRequest {
  spec: unknown;
  targetDir: string;
  dataDir: string;
  openDomain?: boolean;
  existingProject?: boolean;
  previewApproved?: boolean;
  snapshotInput: Omit<BuildVerificationSnapshot, 'verificationId'>;
}

export interface BuildDecision {
  status: RunFinalStatus;
  reasons: string[];
  criteria: Array<{ id: string; status: string }>;
}

export interface BuildCompletionContext {
  criteria: AcceptanceCriterion[];
  nodes: Record<string, NodeResult>;
  snapshot: BuildVerificationSnapshot;
  /** W3 接线修正：verifier input 的相对路径解析基准（脚手架已落盘） */
  stagingDir: string;
}

export interface BuildServicePorts {
  workspace: {
    stage(): Promise<OperationResult<{ stagingDir: string }>>;
    commit(stagingDir: string, targetDir: string): Promise<OperationResult<void>>;
    abandon(stagingDir: string): Promise<void>;
    diff(targetDir: string): Promise<OperationResult<{ changed: string[] }>>;
  };
  /** 每个验收标准 → W3-01 verifier；缺失即 BUILD_VERIFIER_MAPPING_MISSING */
  verifierMap: { resolve(criterion: AcceptanceCriterion): OperationResult<{ verifierId: string }> };
  /** 构建节点（install/build/start/readiness/business-write/stop-port-release/restart/business-read/test/evidence/decision）。
   *  W3 接线修正：节点工厂接收 spec——脚手架节点在 staging 内真实落盘（此前 spec 无通道进入节点）。 */
  nodes(stagingDir: string, snapshot: BuildVerificationSnapshot, spec: unknown): PlanNode[];
  /** 静态入口校验：生成的 server 必须在 / 提供前端，否则 BUILD_STATIC_ENTRY_MISSING。
   *  W3 接线修正：在 DAG 执行后校验（脚手架节点已把项目写入 staging）——此前在空 staging 上预检必失败。 */
  staticEntry: { verify(stagingDir: string, signal: AbortSignal): Promise<OperationResult<{ servesRoot: boolean }>> };
  /** 仅组装未受信任的 completion input；唯一 authority 是 injected CompletionCoordinator。 */
  completionInput(context: BuildCompletionContext): Promise<OperationResult<CompletionGateInput>>;
}

export interface BuildRunResult {
  stagingDir: string;
  committed: boolean;
  snapshot: BuildVerificationSnapshot;
  decision: BuildDecision;
}

export class BuildService {
  constructor(
    private readonly ports: BuildServicePorts,
    private readonly completionCoordinator: CompletionCoordinator,
  ) {}

  async compileAndRun(request: BuildRequest, signal: AbortSignal): Promise<OperationResult<BuildRunResult>> {
    if (request.openDomain) return fail('BUILD_OPEN_DOMAIN_UNSUPPORTED');
    const validated = validateAcceptance(request.spec);
    if (!validated.ok) return validated;
    const criteria = validated.value;
    for (const criterion of criteria) {
      const mapped = this.ports.verifierMap.resolve(criterion);
      if (!mapped.ok) return mapped;
    }
    if (request.existingProject) {
      const diff = await this.ports.workspace.diff(request.targetDir);
      if (!diff.ok) return diff;
      if (diff.value.changed.length > 0 && !request.previewApproved) {
        return fail('BUILD_PREVIEW_APPROVAL_REQUIRED', { changed: diff.value.changed.slice(0, 20) });
      }
    }
    const snapshot = createBuildVerificationSnapshot(request.snapshotInput);
    const staged = await this.ports.workspace.stage();
    if (!staged.ok) return staged;
    const stagingDir = staged.value.stagingDir;
    let settled = false;
    const abandon = async () => {
      if (!settled) {
        settled = true;
        await this.ports.workspace.abandon(stagingDir).catch(() => undefined);
      }
    };
    try {
      if (!CompletionCoordinator.isGenuine(this.completionCoordinator)) {
        await abandon();
        return fail('COMPLETION_COORDINATOR_UNTRUSTED');
      }
      // W3 接线修正：先执行 DAG（scaffold 节点真实落盘 staging），再校验静态入口——
      // 此前在空 staging 上预检，生产上必然 BUILD_STATIC_ENTRY_MISSING。
      const nodes = this.ports.nodes(stagingDir, snapshot, request.spec);
      const executed = await executePlanDag(nodes, signal);
      const staticEntry = await this.ports.staticEntry.verify(stagingDir, signal);
      if (!staticEntry.ok) {
        await abandon();
        return staticEntry;
      }
      if (!staticEntry.value.servesRoot) {
        await abandon();
        return fail('BUILD_STATIC_ENTRY_MISSING', { stagingDir });
      }
      for (const [nodeId, nodeResult] of Object.entries(executed.nodes)) {
        if (nodeResult.status === 'failed' && nodeResult.code !== 'BUILD_NODE_FAILED' && nodeResult.code) {
          await abandon();
          return fail(nodeResult.code, { nodeId });
        }
      }
      const completionInput = await this.ports.completionInput({ criteria, nodes: executed.nodes, snapshot, stagingDir });
      if (!completionInput.ok) {
        await abandon();
        return completionInput;
      }
      let completion;
      try {
        completion = CompletionCoordinator.prototype.decide.call(this.completionCoordinator, completionInput.value);
      } catch {
        await abandon();
        return fail('COMPLETION_COORDINATOR_UNTRUSTED');
      }
      if (!completion.ok) {
        await abandon();
        return completion;
      }
      if (!CompletionCoordinator.prototype.owns.call(this.completionCoordinator, completion.value)) {
        await abandon();
        return fail('COMPLETION_RECEIPT_UNTRUSTED');
      }
      const decision: BuildDecision = {
        status: completion.value.decision.status,
        reasons: [...completion.value.decision.reasons],
        criteria: completion.value.decision.criterionResults.map(item => ({ ...item })),
      };
      if (decision.status !== 'succeeded') {
        await abandon();
        return { ok: true, value: { stagingDir, committed: false, snapshot, decision } };
      }
      const committed = await this.ports.workspace.commit(stagingDir, request.targetDir);
      if (!committed.ok) {
        await abandon();
        return committed;
      }
      settled = true;
      return { ok: true, value: { stagingDir, committed: true, snapshot, decision } };
    } catch (error) {
      await abandon();
      return fail('BUILD_NODE_FAILED', { message: String((error as Error)?.message ?? error) });
    }
  }

  /** 快照漂移断言（evidence/verifier 集成处使用） */
  assertSnapshot(expected: BuildVerificationSnapshot, actual: Partial<BuildVerificationSnapshot>): OperationResult<void> {
    return assertSnapshotMatch(expected, actual);
  }
}
