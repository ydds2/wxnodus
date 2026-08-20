// src/application/tools/toolExecutionWiring.ts — W1-08 生产接线：11 ports 全真实装配
// resolve（ToolCatalog）→ validate（required 键校验）→ normalize（argsHash + effect 资源实例化）
// → decide（SqlitePolicyRepository + decideEffect，deny → POLICY_DENIED）
// → authorizeAndReserve（canonical AuthorizationContext + issue/consume 同事务 + require_approval 走人工审批桥）
// → execute（toolExecutors：pathBoundary/safeFetchText/超时强杀/memory scope）
// → appendJournal（UoW 哈希链）→ verifyPostcondition（真实再探）→ captureEvidence（sha256 原子落盘）
// → commitBudget / releaseBudget（release 退款落链）。未接线 toolId 一律 fail-closed（TOOL_NOT_FOUND/TOOL_EXECUTOR_UNWIRED）。
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { sha256Canonical, type AuthorizationContext } from '../../domain/security/approvalGrant.js';
import { decideEffect, type PolicyDocument } from '../../domain/security/pdp.js';
import { createToolCatalog, type ToolCatalog } from '../../domain/tools/toolCatalog.js';
import { createToolExecutionPipeline, type ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';
import type { ToolDescriptor } from '../../domain/tools/toolDescriptor.js';
import type { ToolId } from '../../domain/tools/toolIds.js';
import type { EffectDescriptor } from '../../domain/effects/effectDescriptor.js';
import type { MemoryRepository } from '../../domain/memory/memoryRepository.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';
import { provisionSecurityControlPlane } from '../../infrastructure/sqlite/securityProvisioning.js';
import { SqliteAuthorizationUnitOfWork } from '../../infrastructure/sqlite/authorizationUnitOfWork.js';
import { SqlitePolicyRepository } from '../../infrastructure/sqlite/policyRepository.js';
import { executeToolId, instantiateEffectResource, verifyToolPostcondition } from './toolExecutors.js';
import { checkRedlineViolation } from './redlineGate.js';
import { classifyPipelineArgs } from '../../infrastructure/fs/windowsPathClassifier.js';
import { createToolEvidenceStore } from './toolEvidenceStore.js';
import type { AgentToolSurface } from './agentToolSurface.js';

export interface ToolExecutionWiringOptions {
  db: Database.Database;
  dataDir: string;
  workspaceRoot: string;
  memoryRepository: MemoryRepository;
  policy: { id: string; document: PolicyDocument };
  budget: { id: string; limits: Record<string, number> };
  /** 人工审批桥（require_approval 时调用；未装配 → APPROVAL_UNAVAILABLE fail-closed） */
  approver?: (request: { invocationId: string; argsHash: string; toolId: ToolId; args: unknown; effect: EffectDescriptor; reasonCode?: string; obligations?: unknown[] }) => Promise<boolean>;
  now?(): string;
  idFactory?(prefix: string): string;
}

export interface ProductionToolExecution {
  pipeline: ToolExecutionPipeline;
  catalog: ToolCatalog;
  uow: SqliteAuthorizationUnitOfWork;
  /** Agent 工具表面绑定后，初始注册和热重载都通过 owner-scoped catalog swap 原子完成。 */
  registerAgentTools(surface: AgentToolSurface): OperationResult<void>;
}

const BUDGET_KEY: Partial<Record<EffectDescriptor['kind'], Record<string, number>>> = {
  'filesystem.write': { externalWrites: 1 },
  'network.request': { networkRequests: 1 },
  'process.spawn': { processSpawns: 1 },
};

const descriptor = (id: ToolId, effects: EffectDescriptor[]): ToolDescriptor => ({
  id, owner: 'builtin:core', inputSchema: { type: 'object' }, effects,
  timeoutMs: 30_000, cancellation: 'supported', idempotency: 'conditional', evidenceProducer: true,
});

const CORE_DESCRIPTORS: readonly ToolDescriptor[] = [
  descriptor('builtin:workspace.read' as ToolId, [
    { kind: 'filesystem.read', resource: 'file://', operation: 'read', external: false, dataClassification: 'internal', reversibility: 'reversible' },
  ]),
  descriptor('builtin:workspace.write' as ToolId, [
    { kind: 'filesystem.write', resource: 'file://', operation: 'replace', external: false, dataClassification: 'internal', reversibility: 'compensatable' },
  ]),
  descriptor('builtin:network.fetch' as ToolId, [
    { kind: 'network.request', resource: 'https://', operation: 'fetch', external: true, dataClassification: 'public', reversibility: 'irreversible' },
  ]),
  descriptor('builtin:process.spawn' as ToolId, [
    { kind: 'process.spawn', resource: 'process://', operation: 'spawn', external: true, dataClassification: 'internal', reversibility: 'compensatable' },
  ]),
  descriptor('builtin:memory' as ToolId, [
    { kind: 'memory.read', resource: 'memory://', operation: 'read', external: false, dataClassification: 'internal', reversibility: 'reversible' },
  ]),
];

/** 每 correlation 一次执行的跟踪（effectId/argsHash/journal 状态——captureEvidence 绑定用） */
interface ExecutionTrace { effectId: string; toolId: ToolId; argsHash: string; states: string[] }

export function createProductionToolExecution(options: ToolExecutionWiringOptions): ProductionToolExecution {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? (prefix => `${prefix}-${randomUUID()}`);
  const provisioned = provisionSecurityControlPlane(options.db, { policy: options.policy, budget: options.budget, now: now() });
  if (!provisioned.ok) {
    throw Object.assign(new Error(`安全控制面置备失败：${provisioned.error.code}`), { code: provisioned.error.code });
  }
  const policies = new SqlitePolicyRepository(options.db);
  const uow = new SqliteAuthorizationUnitOfWork(options.db, policies);
  const catalog = createToolCatalog();
  const registered = catalog.register('builtin:core', CORE_DESCRIPTORS);
  if (!registered.ok) throw Object.assign(new Error(registered.error.code), { code: registered.error.code });
  // Agent surface 晚绑定：surface 先交换 catalog，成功后才提交自身执行表。
  const agentSurface: { value?: AgentToolSurface } = {};
  const registerAgentTools = (surface: AgentToolSurface): OperationResult<void> => {
    const bound = surface.bindCatalogUpdater(incoming => catalog.swapOwner(surface.owner, incoming));
    if (!bound.ok) return bound;
    agentSurface.value = surface;
    return ok(undefined);
  };
  const evidenceStore = createToolEvidenceStore(options.dataDir);
  const reservations = new Map<string, Record<string, number>>();
  const traces = new Map<string, ExecutionTrace>();

  const pipeline = createToolExecutionPipeline({
    resolve: async toolId => catalog.resolve(toolId),
    validate: async (tool, args) => {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return err(gatewayError('TOOL_ARGS_INVALID', `工具参数必须为对象：${tool.id}`, 'tool.args.invalid'));
      }
      const required = (tool.inputSchema as { required?: unknown })?.required;
      if (Array.isArray(required)) {
        for (const key of required) {
          if (!(key in (args as Record<string, unknown>))) {
            return err(gatewayError('TOOL_ARGS_INVALID', `工具缺少必填参数：${String(key)}`, 'tool.args.invalid'));
          }
        }
      }
      return ok(undefined);
    },
    normalize: async (tool, args, context) => {
      const argsHash = sha256Canonical(args);
      const agent = agentSurface.value;
      const resource = (agent && tool.owner === agent.owner ? agent.instantiateResource(tool.id, args, context) : undefined)
        ?? instantiateEffectResource(tool.id, args, context, options.workspaceRoot);
      const effect = { ...tool.effects[0]!, resource };
      traces.set(context.correlationId, { effectId: context.correlationId, toolId: tool.id, argsHash, states: [] });
      return ok({ args, argsHash, effect, toolId: tool.id });
    },
    decide: async input => {
      // W8-01：硬红线管线闸——先于策略独立复检（任何模式/策略/审批不可绕过；命中即拒，零副作用）
      const redline = checkRedlineViolation(input.args);
      if (redline.id) {
        return err(gatewayError('HARD_REDLINE_DENIED', `命中硬红线：${redline.id}（任何模式不可绕过）`, 'redline.denied'));
      }
      // W7-02：系统路径感知确认——system-touch（系统目录/隐藏·系统属性/reparse/命令引用系统根）
      // 强制专属确认（分类理由随 decision 进入审批展示与 journal 审计链）
      const systemTouch = classifyPipelineArgs(input.args, options.workspaceRoot);
      if (systemTouch) {
        return ok({ action: 'require_approval', reasonCode: 'SYSTEM_TOUCH_REQUIRES_CONFIRMATION', obligations: [{ kind: 'system-touch', class: systemTouch.class, path: systemTouch.path, reason: systemTouch.reason }] });
      }
      const policy = policies.loadActive();
      if (!policy.ok) return err(gatewayError('POLICY_UNAVAILABLE', 'policy 快照不可用', 'policy.unavailable'));
      const verdict = decideEffect(policy.value.document, input.effect.kind);
      if (verdict === 'deny') return err(gatewayError('POLICY_DENIED', `effect 被策略拒绝：${input.effect.kind}`, 'policy.denied'));
      return ok({ action: verdict, reasonCode: verdict === 'allow' ? 'POLICY_ALLOW' : 'POLICY_REQUIRE_APPROVAL', obligations: [] });
    },
    authorizeAndReserve: async (input, decision, context) => {
      const toolId = input.toolId;
      if (!toolId) return err(gatewayError('TOOL_AUTHORIZATION_UNWIRED', 'authorize 缺少 toolId（normalize 未接线）', 'tool.authorization.unwired'));
      const policyId = uow.activePolicySnapshotId();
      if (!policyId.ok) return policyId;
      const budgetId = uow.activeBudgetSnapshotId();
      if (!budgetId.ok) return budgetId;
      const authorization: AuthorizationContext = {
        invocationId: context.correlationId,
        actorId: context.actorId,
        sessionId: context.sessionId,
        runId: context.runId ?? 'none',
        toolId,
        argsHash: input.argsHash,
        effect: input.effect,
        resourceHash: sha256Canonical(input.effect.resource),
        policySnapshotId: policyId.value,
        budgetSnapshotId: budgetId.value,
      };
      if (decision.action === 'require_approval') {
        if (!options.approver) return err(gatewayError('APPROVAL_UNAVAILABLE', 'require_approval 且无审批桥——fail-closed', 'approval.unavailable'));
        // W7-02：决策理由（system-touch 分类等）随审批请求透出——确认弹窗展示分类理由，journal 审计链留痕
        const allowed = await options.approver({ invocationId: context.correlationId, argsHash: input.argsHash, toolId, args: input.args, effect: input.effect, reasonCode: decision.reasonCode, obligations: decision.obligations });
        if (!allowed) return err(gatewayError('POLICY_DENIED', '审批拒绝', 'policy.denied'));
      }
      const reservation = BUDGET_KEY[input.effect.kind] ?? {};
      const issued = uow.issue({
        id: idFactory('grant'),
        context: authorization,
        nonce: idFactory('nonce'),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        now: now(),
      });
      if (!issued.ok) return issued;
      const consumed = uow.consumeAndReserve({ grantId: issued.value.id, context: authorization, reservation, now: now() });
      if (!consumed.ok) return consumed;
      reservations.set(consumed.value.reservationId, reservation);
      return ok({ reservationId: consumed.value.reservationId });
    },
    execute: async (tool, args, context, signal) => {
      const agent = agentSurface.value;
      if (agent && tool.owner === agent.owner) return agent.execute(tool.id, args, context, signal);
      return executeToolId(tool.id, args, context, { workspaceRoot: options.workspaceRoot, memoryRepository: options.memoryRepository }, signal);
    },
    appendJournal: async (state, payload, context) => {
      const effectId = String((payload as { effectId?: unknown } | undefined)?.effectId ?? context.correlationId);
      const trace = traces.get(context.correlationId);
      if (trace) trace.states.push(state);
      return uow.appendJournalEntry(effectId, state, payload, now());
    },
    verifyPostcondition: async (tool, value, context) => {
      const agent = agentSurface.value;
      if (agent && tool.owner === agent.owner) return agent.verifyPostcondition(tool.id, value, context);
      return verifyToolPostcondition(tool.id, value, context, { workspaceRoot: options.workspaceRoot, memoryRepository: options.memoryRepository });
    },
    captureEvidence: async (tool, value, context) => {
      const trace = traces.get(context.correlationId) ?? {
        effectId: context.correlationId, toolId: tool.id, argsHash: sha256Canonical(value), states: [],
      };
      const result = evidenceStore.close(trace.effectId, {
        toolId: tool.id, argsHash: trace.argsHash, context, journal: trace.states, value,
      });
      if (result.ok) traces.delete(context.correlationId);
      return result.ok ? ok([result.value.evidenceId]) : result;
    },
    commitBudget: async (reservationId, value, context) => {
      void context;
      if (!reservationId) return ok(undefined);
      const committed = uow.commit(reservationId, value, now());
      if (committed.ok) reservations.delete(reservationId);
      return committed;
    },
    releaseBudget: async (reservationId, context) => {
      void context;
      if (!reservationId) return ok(undefined);
      const reservation = reservations.get(reservationId) ?? {};
      const released = uow.release(reservationId, reservation, now());
      if (released.ok) reservations.delete(reservationId);
      return released;
    },
  });

  return { pipeline, catalog, uow, registerAgentTools };
}
