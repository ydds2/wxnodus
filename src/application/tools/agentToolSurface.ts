// src/application/tools/agentToolSurface.ts — C3：agent 主路径工具经生产 11-port pipeline 真实执行（分层复用）
// 审批权威仍在 agent 前置链（modeVerdict/autoReview/lowRisk/onApproval/红线——走到本 surface 即已放行）；
// pipeline 为强制记账层：PDP 复核 → grant/budget → effect-journal → evidence → postcondition（真实再探）。
// 审批桥：WeakMap<args, true>——runner 执行前标记「legacy 已放行」，CLI approver 对 agent:* 读桥返回
// （args 对象身份经 pipeline normalize 原样传递到 approver；agent 同回合串行执行，无并发槽冲突）。
// 只覆盖 danger/写类工具；只读工具维持 legacy（诚实 shadow，不伪装全面接管）。
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDef, ToolCtx } from '../../kernel/tools.js';
import type { ToolId } from '../../domain/tools/toolIds.js';
import type { ToolDescriptor } from '../../domain/tools/toolDescriptor.js';
import type { EffectDescriptor, EffectKind } from '../../domain/effects/effectDescriptor.js';
import type { ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

/** agent 工具名 → effect kind（PDP 策略裁决 + 预算计费维度）；未列出的只读工具维持 legacy */
const AGENT_EFFECT_KIND: Record<string, EffectKind> = {
  fs_write: 'filesystem.write', fs_edit: 'filesystem.write', scaffold_build: 'filesystem.write',
  bash: 'process.spawn', wx_cmd: 'process.spawn',
  http_get: 'network.request', http_request: 'network.request', web_search: 'network.request',
  browser_navigate: 'network.request', browser_click: 'network.request', browser_type: 'network.request',
  memory_write: 'memory.write', memory_update: 'memory.write', memory_delete: 'memory.write',
  cron_create: 'config.write', credential_form: 'config.write',
  delegate: 'extension.manage',
  computer_click: 'ui.external', computer_type: 'ui.external', computer_open: 'ui.external',
  computer_screenshot: 'ui.external', computer_observe: 'ui.external',
  computer_uia_click: 'ui.external', computer_uia_type: 'ui.external',
};

/** ToolId local part 合法（[a-z0-9][a-z0-9._-]*）：fs_write → agent:fs.write */
const agentToolId = (name: string): ToolId => `agent:${name.replace(/_/g, '.')}` as ToolId;
const nameFromToolId = (toolId: ToolId): string => String(toolId).replace(/^agent:/, '').replace(/\./g, '_');

const effectFor = (name: string): EffectDescriptor => {
  const kind = AGENT_EFFECT_KIND[name]!;
  return {
    kind,
    resource: 'unknown://', // normalize 时经 instantiateResource 从 args 确定性实例化
    operation: kind === 'filesystem.write' ? 'replace' : kind === 'process.spawn' ? 'spawn' : kind === 'network.request' ? 'fetch' : kind === 'memory.write' ? 'write' : kind === 'extension.manage' ? 'execute' : 'invoke',
    external: kind === 'network.request' || kind === 'process.spawn' || kind === 'ui.external',
    dataClassification: 'internal',
    reversibility: kind === 'network.request' ? 'irreversible' : 'compensatable',
  };
};

const descriptor = (name: string): ToolDescriptor => ({
  id: agentToolId(name),
  owner: 'agent:core',
  inputSchema: { type: 'object' }, // required 校验权威在 agent 前置链 validateToolArgs（pipeline 只做对象形状校验）
  effects: [effectFor(name)],
  timeoutMs: 30_000,
  cancellation: 'supported',
  idempotency: 'conditional',
  evidenceProducer: true,
});

export interface AgentToolSurface {
  descriptors: readonly ToolDescriptor[];
  execute(toolId: ToolId, args: unknown, context: OperationContext, _signal: AbortSignal): Promise<unknown>;
  verifyPostcondition(toolId: ToolId, value: unknown, _context: OperationContext): Promise<OperationResult<void>>;
  instantiateResource(toolId: ToolId, args: unknown, context: OperationContext): string | undefined;
}

export interface AgentToolRunner {
  handles(name: string): boolean;
  execute(name: string, args: Record<string, any>, toolCtx: ToolCtx): Promise<OperationResult<{ output: string }>>;
}

export interface AgentApprovalBridge {
  mark(args: object, allowed: boolean): void;
  consume(args: unknown): boolean;
}

export function createAgentApprovalBridge(): AgentApprovalBridge {
  const decisions = new WeakMap<object, boolean>();
  return {
    mark: (args, allowed) => { if (allowed) decisions.set(args, true); },
    consume: args => (typeof args === 'object' && args !== null ? decisions.get(args) === true : false),
  };
}

export function createAgentToolSurface(options: { tools: Record<string, ToolDef> }): {
  surface: AgentToolSurface;
  attach(pipeline: ToolExecutionPipeline, bridge: AgentApprovalBridge): AgentToolRunner;
  updateTools(tools: Record<string, ToolDef>): void;
} {
  let toolTable = { ...options.tools };
  // toolCtx 槽：runner 在每次执行前绑定（agent 同回合串行执行不变量——无并发覆盖）
  const slot: { ctx?: ToolCtx } = {};

  const execute: AgentToolSurface['execute'] = async (toolId, args, _context, _signal) => {
    const name = nameFromToolId(toolId);
    const tool = toolTable[name];
    const ctx = slot.ctx;
    if (!tool) return err(gatewayError('TOOL_EXECUTOR_UNWIRED', `agent 工具执行器未接线：${String(toolId)}`, 'tool.executor.unwired'));
    if (!ctx) return err(gatewayError('AGENT_TOOL_CONTEXT_UNBOUND', 'agent 工具上下文未绑定（runner 未装配）——fail-closed', 'tool.context.unbound'));
    const input = (args ?? {}) as Record<string, unknown>;
    try {
      const output = await tool.run(input, ctx);
      const path = typeof input.path === 'string' && input.path
        ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd ?? process.cwd(), input.path))
        : undefined;
      return ok({ output: String(output), ...(path ? { path } : {}) });
    } catch (cause) {
      return err(gatewayError('TOOL_EXECUTE_FAILED', `${name} 执行失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'tool.execute.failed'));
    }
  };

  const verifyPostcondition: AgentToolSurface['verifyPostcondition'] = async (toolId, value, _context) => {
    const name = nameFromToolId(toolId);
    const observed = value as { output?: unknown; path?: unknown } | null | undefined;
    if (!observed || typeof observed !== 'object' || typeof observed.output !== 'string') {
      return err(gatewayError('TOOL_RESULT_INVALID', `${String(toolId)} 返回值形状非法`, 'tool.result.invalid'));
    }
    // fs_write/fs_edit：真实再探——目标文件确实存在（写后校验）；其余形状检查（输出为回填文本）
    if (name === 'fs_write' || name === 'fs_edit') {
      if (typeof observed.path !== 'string' || !observed.path || !existsSync(observed.path)) {
        return err(gatewayError('TOOL_POSTCONDITION_FAILED', `写后校验失败：${String(observed.path ?? '(路径缺失)')}`, 'tool.postcondition.failed'));
      }
    }
    return ok(undefined);
  };

  const instantiateResource: AgentToolSurface['instantiateResource'] = (toolId, args, context): string | undefined => {
    const name = nameFromToolId(toolId);
    const kind = AGENT_EFFECT_KIND[name];
    if (!kind) return undefined;
    const input = (args ?? {}) as Record<string, unknown>;
    switch (kind) {
      case 'filesystem.write': {
        const p = String(input.path ?? '');
        return p ? `file://${isAbsolute(p) ? p : resolve(process.cwd(), p)}` : 'file://';
      }
      case 'process.spawn': return `process://${String(input.command ?? '').slice(0, 120)}`;
      case 'network.request': return String(input.url ?? '');
      case 'memory.write': return `memory://${context.sessionId}`;
      case 'config.write': return `config://${name}`;
      case 'extension.manage': return `extension://${name}`;
      case 'ui.external': return `ui://${name}`;
      default: return undefined;
    }
  };

  const descriptors = Object.keys(AGENT_EFFECT_KIND).filter(name => toolTable[name]).map(descriptor);

  return {
    surface: { descriptors, execute, verifyPostcondition, instantiateResource },
    updateTools: tools => { toolTable = { ...tools }; },
    attach(pipeline, bridge): AgentToolRunner {
      return {
        handles: name => !!AGENT_EFFECT_KIND[name] && !!toolTable[name],
        async execute(name, args, toolCtx) {
          slot.ctx = toolCtx; // 串行不变量：agent 同回合工具顺序执行
          bridge.mark(args, true); // legacy 前置链已放行（走到此处即已通过审批）——approver 读桥不再二次弹窗
          const correlationId = `agent-${randomUUID()}`;
          const result = await pipeline.execute(
            { id: correlationId, toolId: agentToolId(name), args },
            {
              actorId: 'actor:agent',
              sessionId: String(toolCtx.sessionId ?? 'default'),
              runId: 'agent-loop',
              correlationId,
              policySnapshotId: '',
              locale: 'zh-CN',
              source: 'kernel',
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
        },
      };
    },
  };
}
