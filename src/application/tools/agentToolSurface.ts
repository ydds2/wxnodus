// src/application/tools/agentToolSurface.ts — Agent 全工具经生产 pipeline 执行
// legacy 权限链只签发一次性 invocation 授权；pipeline 独立复核 PDP、预算、journal、证据与后置条件。
// ToolDef/ToolCtx/ToolId 按 correlationId 固定，热重载不会改变执行中的 invocation。
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDef, ToolCtx } from '../../kernel/tools.js';
import type { ToolId, ToolNamespace } from '../../domain/tools/toolIds.js';
import type { ToolDescriptor } from '../../domain/tools/toolDescriptor.js';
import type { EffectDescriptor, EffectKind } from '../../domain/effects/effectDescriptor.js';
import { sha256Canonical } from '../../domain/security/approvalGrant.js';
import type { ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import type { RunContext } from '../../protocol/runs.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

const AGENT_TOOL_OWNER = 'agent:runtime';

const AGENT_EFFECT_KIND: Record<string, EffectKind> = {
  fs_read: 'filesystem.read', find_files: 'filesystem.read', ls: 'filesystem.read', grep: 'filesystem.read',
  skill_load: 'filesystem.read', repo_map: 'filesystem.read', view_image: 'filesystem.read',
  lsp_diagnostics: 'filesystem.read', lsp_hover: 'filesystem.read', lsp_definition: 'filesystem.read',
  fs_write: 'filesystem.write', fs_edit: 'filesystem.write', apply_patch: 'filesystem.write', scaffold_build: 'filesystem.write',
  bash: 'process.spawn', wx_cmd: 'process.spawn',
  http_get: 'network.request', http_request: 'network.request', web_search: 'network.request', browser_navigate: 'network.request',
  memory_search: 'memory.read', command_search: 'memory.read', tool_search: 'memory.read',
  memory_write: 'memory.write', memory_update: 'memory.write', memory_delete: 'memory.write',
  cron_create: 'config.write', credential_form: 'config.write', todo: 'config.write',
  delegate: 'extension.manage',
  ask_user: 'ui.external', clarify: 'ui.external', notify: 'ui.external',
  browser_click: 'ui.external', browser_type: 'ui.external', browser_screenshot: 'ui.external',
  browser_snapshot: 'ui.external', browser_wait: 'ui.external', browser_close: 'ui.external',
  computer_click: 'ui.external', computer_type: 'ui.external', computer_open: 'ui.external',
  computer_screenshot: 'ui.external', computer_observe: 'ui.external', computer_uia_windows: 'ui.external',
  computer_uia_tree: 'ui.external', computer_uia_find: 'ui.external', computer_uia_click: 'ui.external',
  computer_uia_type: 'ui.external', computer_uia_act: 'ui.external',
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[^a-z0-9]+|[._-]+$/g, '') || 'tool';
}

function toolIdFor(name: string, tool: ToolDef): ToolId {
  const namespace: ToolNamespace = tool.canonical?.namespace ?? 'agent';
  if (namespace === 'agent') return `agent:${slug(name.replace(/_/g, '.'))}` as ToolId;
  const source = slug(tool.canonical?.source ?? namespace);
  const digest = sha256Canonical({ namespace, source: tool.canonical?.source ?? '', name }).slice(0, 12);
  return `${namespace}:${source}.${slug(name)}.${digest}` as ToolId;
}

function effectKindFor(name: string, tool: ToolDef): EffectKind {
  return tool.canonical?.effectKind ?? AGENT_EFFECT_KIND[name] ?? 'extension.manage';
}

function effectFor(name: string, tool: ToolDef): EffectDescriptor {
  const kind = effectKindFor(name, tool);
  return {
    kind,
    resource: 'unknown://',
    operation: kind === 'filesystem.read' ? 'read'
      : kind === 'filesystem.write' ? 'replace'
        : kind === 'process.spawn' ? 'spawn'
          : kind === 'network.request' ? 'fetch'
            : kind === 'memory.read' ? 'read'
              : kind === 'memory.write' ? 'write'
                : kind === 'extension.manage' ? 'execute'
                  : 'invoke',
    external: kind === 'network.request' || kind === 'process.spawn' || kind === 'ui.external' || kind === 'extension.manage',
    dataClassification: 'internal',
    reversibility: kind === 'network.request' || kind === 'extension.manage' ? 'irreversible'
      : kind === 'filesystem.read' || kind === 'memory.read' ? 'reversible'
        : 'compensatable',
  };
}

function buildRegistration(tools: Record<string, ToolDef>): OperationResult<{
  descriptors: ToolDescriptor[];
  nameToId: Map<string, ToolId>;
  idToName: Map<ToolId, string>;
}> {
  const descriptors: ToolDescriptor[] = [];
  const nameToId = new Map<string, ToolId>();
  const idToName = new Map<ToolId, string>();
  for (const [name, tool] of Object.entries(tools)) {
    const id = toolIdFor(name, tool);
    const collision = idToName.get(id);
    if (collision && collision !== name) {
      return err(gatewayError('TOOL_ID_COLLISION', `工具规范化后 ID 冲突：${collision} / ${name}`, 'tool.id.collision', {
        retryable: false,
        details: { toolId: id, names: [collision, name] },
      }));
    }
    nameToId.set(name, id);
    idToName.set(id, name);
    descriptors.push({
      id,
      owner: AGENT_TOOL_OWNER,
      inputSchema: tool.schema.function.parameters,
      effects: [effectFor(name, tool)],
      timeoutMs: 30_000,
      cancellation: 'supported',
      idempotency: effectKindFor(name, tool) === 'filesystem.read' || effectKindFor(name, tool) === 'memory.read' ? 'idempotent' : 'conditional',
      evidenceProducer: true,
    });
  }
  return ok({ descriptors, nameToId, idToName });
}

interface InvocationBinding {
  name: string;
  id: ToolId;
  tool: ToolDef;
  ctx: ToolCtx;
}

export interface AgentToolSurface {
  readonly owner: string;
  readonly descriptors: readonly ToolDescriptor[];
  execute(toolId: ToolId, args: unknown, context: OperationContext, signal: AbortSignal): Promise<unknown>;
  verifyPostcondition(toolId: ToolId, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  instantiateResource(toolId: ToolId, args: unknown, context: OperationContext): string | undefined;
  bindCatalogUpdater(update: (descriptors: readonly ToolDescriptor[]) => OperationResult<unknown>): OperationResult<void>;
}

export interface AgentToolRunner {
  handles(name: string): boolean;
  execute(name: string, args: Record<string, any>, toolCtx: ToolCtx, runContext: RunContext): Promise<OperationResult<{ output: string }>>;
}

export interface AgentApprovalBridge {
  mark(invocationId: string, argsHash: string): void;
  consume(invocationId: string, argsHash: string): boolean;
  discard(invocationId: string): void;
}

export function createAgentApprovalBridge(): AgentApprovalBridge {
  const decisions = new Map<string, string>();
  return {
    mark: (invocationId, argsHash) => { decisions.set(invocationId, argsHash); },
    consume: (invocationId, argsHash) => {
      const allowed = decisions.get(invocationId) === argsHash;
      decisions.delete(invocationId);
      return allowed;
    },
    discard: invocationId => { decisions.delete(invocationId); },
  };
}

export function createAgentToolSurface(options: { tools: Record<string, ToolDef> }): {
  surface: AgentToolSurface;
  attach(pipeline: ToolExecutionPipeline, bridge: AgentApprovalBridge): AgentToolRunner;
  updateTools(tools: Record<string, ToolDef>): OperationResult<void>;
} {
  const initial = buildRegistration(options.tools);
  if (!initial.ok) throw Object.assign(new Error(initial.error.message), { code: initial.error.code });
  let toolTable = { ...options.tools };
  let descriptors = initial.value.descriptors;
  let nameToId = initial.value.nameToId;
  let idToName = initial.value.idToName;
  let catalogUpdater: ((incoming: readonly ToolDescriptor[]) => OperationResult<unknown>) | undefined;
  const invocationContexts = new Map<string, InvocationBinding>();

  const bindingFor = (toolId: ToolId, context: OperationContext): InvocationBinding | undefined => {
    const bound = invocationContexts.get(context.correlationId);
    return bound?.id === toolId ? bound : undefined;
  };

  const surface: AgentToolSurface = {
    owner: AGENT_TOOL_OWNER,
    get descriptors() { return descriptors; },
    bindCatalogUpdater(update) {
      if (catalogUpdater) {
        return err(gatewayError('AGENT_TOOL_CATALOG_ALREADY_BOUND', 'Agent tool catalog updater 已绑定', 'tool.catalog.already_bound'));
      }
      const registered = update(descriptors);
      if (!registered.ok) return err(registered.error);
      catalogUpdater = update;
      return ok(undefined);
    },
    async execute(toolId, args, context, _signal) {
      const bound = bindingFor(toolId, context);
      if (!bound) return err(gatewayError('AGENT_TOOL_CONTEXT_UNBOUND', 'Agent 工具 invocation 未绑定——fail-closed', 'tool.context.unbound'));
      const input = (args ?? {}) as Record<string, unknown>;
      try {
        const output = await bound.tool.run(input, bound.ctx);
        const path = typeof input.path === 'string' && input.path
          ? (isAbsolute(input.path) ? input.path : resolve(bound.ctx.cwd, input.path))
          : undefined;
        return ok({ output: String(output), ...(path ? { path } : {}) });
      } catch (cause) {
        return err(gatewayError('TOOL_EXECUTE_FAILED', `${bound.name} 执行失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'tool.execute.failed'));
      }
    },
    async verifyPostcondition(toolId, value, context) {
      const name = bindingFor(toolId, context)?.name ?? idToName.get(toolId);
      const observed = value as { output?: unknown; path?: unknown } | null | undefined;
      if (!name || !observed || typeof observed !== 'object' || typeof observed.output !== 'string') {
        return err(gatewayError('TOOL_RESULT_INVALID', `${String(toolId)} 返回值形状非法`, 'tool.result.invalid'));
      }
      if (name === 'fs_write' || name === 'fs_edit') {
        if (typeof observed.path !== 'string' || !observed.path || !existsSync(observed.path)) {
          return err(gatewayError('TOOL_POSTCONDITION_FAILED', `写后校验失败：${String(observed.path ?? '(路径缺失)')}`, 'tool.postcondition.failed'));
        }
      }
      return ok(undefined);
    },
    instantiateResource(toolId, args, context) {
      const bound = bindingFor(toolId, context);
      const name = bound?.name ?? idToName.get(toolId);
      const tool = bound?.tool ?? (name ? toolTable[name] : undefined);
      if (!name || !tool) return undefined;
      const kind = effectKindFor(name, tool);
      const input = (args ?? {}) as Record<string, unknown>;
      switch (kind) {
        case 'filesystem.read':
        case 'filesystem.write': {
          const cwd = bound?.ctx.cwd;
          const raw = String(input.path ?? cwd ?? '');
          return raw ? `file://${isAbsolute(raw) ? raw : resolve(cwd ?? raw, raw)}` : 'file://';
        }
        case 'process.spawn': return `process://${String(input.command ?? input.executable ?? name).slice(0, 120)}`;
        case 'network.request': return String(input.url ?? `network://${name}`);
        case 'memory.read':
        case 'memory.write': return `memory://${context.sessionId}`;
        case 'config.write': return `config://${name}`;
        case 'extension.manage': return `extension://${tool.canonical?.namespace ?? 'agent'}/${tool.canonical?.source ?? name}/${name}`;
        case 'ui.external': return `ui://${name}`;
      }
    },
  };

  const updateTools = (tools: Record<string, ToolDef>): OperationResult<void> => {
    const candidate = buildRegistration(tools);
    if (!candidate.ok) return candidate;
    if (catalogUpdater) {
      const swapped = catalogUpdater(candidate.value.descriptors);
      if (!swapped.ok) return err(swapped.error);
    }
    toolTable = { ...tools };
    descriptors = candidate.value.descriptors;
    nameToId = candidate.value.nameToId;
    idToName = candidate.value.idToName;
    return ok(undefined);
  };

  return {
    surface,
    updateTools,
    attach(pipeline, bridge): AgentToolRunner {
      return {
        handles: name => nameToId.has(name) && !!toolTable[name],
        async execute(name, args, toolCtx, runContext) {
          const id = nameToId.get(name);
          const tool = toolTable[name];
          if (!id || !tool) return err(gatewayError('TOOL_NOT_FOUND', `Agent 工具未注册：${name}`, 'tool.not_found'));
          const correlationId = `agent-${randomUUID()}`;
          invocationContexts.set(correlationId, { name, id, tool, ctx: toolCtx });
          bridge.mark(correlationId, sha256Canonical(args));
          try {
            const result = await pipeline.execute(
              { id: correlationId, toolId: id, args },
              {
                actorId: runContext.actorId,
                sessionId: runContext.sessionId,
                runId: runContext.runId,
                correlationId,
                parentCorrelationId: runContext.correlationId,
                policySnapshotId: '',
                locale: 'zh-CN',
                source: runContext.source,
                capabilities: [],
                timestamp: new Date().toISOString(),
              },
              toolCtx.signal ?? new AbortController().signal,
            );
            if (!result.ok) return err(result.error);
            const value = result.value.value as { output?: unknown };
            if (typeof value?.output !== 'string') {
              return err(gatewayError('TOOL_RESULT_INVALID', `${name} pipeline 返回值形状非法`, 'tool.result.invalid'));
            }
            return ok({ output: value.output });
          } finally {
            bridge.discard(correlationId);
            invocationContexts.delete(correlationId);
          }
        },
      };
    },
  };
}
