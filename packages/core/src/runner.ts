// packages/core/src/runner.ts — 嵌入门面工具执行器：复用 tests/support/createPipelineAgent 同款生产管线
// （canonical pipeline + fail-closed 审批缺省拒绝 + DEFAULT_TOOL_POLICY）——嵌入场景与 CLI 同一执行边界。
import { createAgentApprovalBridge, createAgentToolSurface } from '../../../src/application/tools/agentToolSurface.js';
import { DEFAULT_TOOL_BUDGET_LIMITS, DEFAULT_TOOL_POLICY } from '../../../src/application/tools/defaultToolPolicy.js';
import { createProductionToolExecution } from '../../../src/application/tools/toolExecutionWiring.js';
import { openMemoryRepository } from '../../../src/infrastructure/sqlite/memoryRepository.js';
import { coreTools } from '../../../src/kernel/tools.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export async function createPipelineAgentLikeRunner(opts: { db: Database.Database; dataDir: string; workspaceRoot: string }) {
  const memoryRepository = openMemoryRepository(opts.db, {
    now: () => Date.now(),
    idFactory: prefix => `${prefix}-${randomUUID()}`,
  });
  const bridge = createAgentApprovalBridge();
  const execution = createProductionToolExecution({
    db: opts.db,
    dataDir: opts.dataDir,
    workspaceRoot: opts.workspaceRoot,
    memoryRepository,
    policy: { id: `core-policy-${randomUUID()}`, document: DEFAULT_TOOL_POLICY },
    budget: { id: `core-budget-${randomUUID()}`, limits: DEFAULT_TOOL_BUDGET_LIMITS },
    approver: request => Promise.resolve(bridge.consume(request.invocationId, request.argsHash)),
  });
  const agentTool = createAgentToolSurface({ tools: coreTools() });
  const registered = execution.registerAgentTools(agentTool.surface);
  if (!registered.ok) throw Object.assign(new Error(registered.error.message), { code: registered.error.code });
  return agentTool.attach(execution.pipeline, bridge);
}
