import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  createAgentApprovalBridge,
  createAgentToolSurface,
} from '../../src/application/tools/agentToolSurface.js';
import {
  DEFAULT_TOOL_BUDGET_LIMITS,
  DEFAULT_TOOL_POLICY,
} from '../../src/application/tools/defaultToolPolicy.js';
import { createProductionToolExecution } from '../../src/application/tools/toolExecutionWiring.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createAgent, type AgentOptions } from '../../src/kernel/agent.js';
import { coreTools } from '../../src/kernel/tools.js';

/** Test composition for Agent integration tests. Production fail-closed behavior stays unchanged. */
export function createPipelineAgent(options: AgentOptions): ReturnType<typeof createAgent> {
  const id = randomUUID();
  const dbPath = String(options.db.name ?? '');
  const dataDir = options.dataDir ?? (dbPath && dbPath !== ':memory:' ? dirname(dbPath) : process.cwd());
  const workspaceRoot = options.workspaceRoot ?? dataDir;
  const memoryRepository = openMemoryRepository(options.db, {
    now: () => Date.now(),
    idFactory: prefix => `${prefix}-${randomUUID()}`,
  });
  const bridge = createAgentApprovalBridge();
  const execution = createProductionToolExecution({
    db: options.db,
    dataDir,
    workspaceRoot,
    memoryRepository,
    policy: { id: `test-policy-${id}`, document: DEFAULT_TOOL_POLICY },
    budget: { id: `test-budget-${id}`, limits: DEFAULT_TOOL_BUDGET_LIMITS },
    approver: request => Promise.resolve(bridge.consume(request.invocationId, request.argsHash)),
  });
  const agentTool = createAgentToolSurface({ tools: coreTools() });
  const registered = execution.registerAgentTools(agentTool.surface);
  if (!registered.ok) throw Object.assign(new Error(registered.error.message), { code: registered.error.code });
  const runner = agentTool.attach(execution.pipeline, bridge);
  return createAgent({
    ...options,
    agentToolRunner: runner,
    onToolTableUpdate: agentTool.updateTools,
  });
}
