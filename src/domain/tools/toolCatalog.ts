// src/domain/tools/toolCatalog.ts — 命名空间化工具目录：owner 注册/校验/裸名兼容/不可变快照
import { randomUUID } from 'node:crypto';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { ToolDescriptor } from './toolDescriptor.js';
import { localToolName, parseToolId, type ToolId } from './toolIds.js';

function freezeDescriptor(tool: ToolDescriptor): ToolDescriptor {
  return Object.freeze({
    ...tool,
    inputSchema: Object.freeze({ ...tool.inputSchema }),
    effects: Object.freeze(tool.effects.map(effect => Object.freeze({ ...effect }))),
  });
}

function validateDescriptor(tool: ToolDescriptor) {
  if (!tool.effects?.length) return 'effects';
  if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) return 'timeoutMs';
  if (!['required', 'supported', 'unsupported'].includes(tool.cancellation)) return 'cancellation';
  if (!['idempotent', 'conditional', 'non_idempotent'].includes(tool.idempotency)) return 'idempotency';
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object') return 'inputSchema';
  return null;
}

export function createToolCatalog() {
  const tools = new Map<ToolId, ToolDescriptor>();
  return {
    register(owner: string, incoming: readonly ToolDescriptor[]) {
      for (const tool of incoming) {
        if (tool.owner !== owner) {
          return err(gatewayError('TOOL_OWNER_MISMATCH', 'tool owner 与 registration owner 不一致', 'tool.owner.mismatch', {
            retryable: false,
            details: { owner, descriptorOwner: tool.owner },
          }));
        }
        const parsed = parseToolId(tool.id);
        if (!parsed.ok) return parsed;
        const missing = validateDescriptor(tool);
        if (missing) {
          return err(gatewayError('TOOL_DESCRIPTOR_INCOMPLETE', `tool descriptor 缺少 ${missing}`, 'tool.descriptor.incomplete', {
            retryable: false,
            details: { field: missing, toolId: tool.id },
          }));
        }
        if (tools.has(tool.id)) {
          return err(gatewayError('TOOL_ALREADY_REGISTERED', `ToolId 已注册：${tool.id}`, 'tool.already_registered'));
        }
      }
      const registrationId = randomUUID();
      const ids = incoming.map(tool => tool.id);
      for (const tool of incoming) tools.set(tool.id, freezeDescriptor(tool));
      let disposed = false;
      return ok({
        id: registrationId,
        owner,
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const id of ids) {
            if (tools.get(id)?.owner === owner) tools.delete(id);
          }
        },
      });
    },
    resolve(raw: string) {
      if (raw.includes(':')) {
        const parsed = parseToolId(raw);
        if (!parsed.ok) return parsed;
        const tool = tools.get(parsed.value);
        return tool ? ok(tool) : err(gatewayError('TOOL_NOT_FOUND', `tool 不存在：${raw}`, 'tool.not_found'));
      }
      const matches = [...tools.values()].filter(tool => localToolName(tool.id) === raw);
      if (matches.length === 1) return ok(matches[0]!);
      if (matches.length > 1) {
        return err(gatewayError('TOOL_ID_AMBIGUOUS', `裸 tool name 有歧义：${raw}`, 'tool.id.ambiguous', {
          retryable: false,
          details: { candidates: matches.map(x => x.id) },
        }));
      }
      return err(gatewayError('TOOL_NOT_FOUND', `tool 不存在：${raw}`, 'tool.not_found'));
    },
    list(owner?: string) {
      return [...tools.values()].filter(tool => !owner || tool.owner === owner).sort((a, b) => a.id.localeCompare(b.id));
    },
    snapshot(): readonly ToolDescriptor[] {
      return Object.freeze([...tools.values()].sort((a, b) => a.id.localeCompare(b.id)));
    },
    /** W2-04：owner 原子换入（同事务单次可见 revision swap——成功后调用方才 dispose 旧 scope） */
    swapOwner(owner: string, incoming: readonly ToolDescriptor[]) {
      for (const tool of incoming) {
        if (tool.owner !== owner) return err(gatewayError('TOOL_OWNER_MISMATCH', 'tool owner 与 swap owner 不一致', 'tool.owner.mismatch'));
        const missing = validateDescriptor(tool);
        if (missing) return err(gatewayError('TOOL_DESCRIPTOR_INCOMPLETE', `tool descriptor 缺少 ${missing}`, 'tool.descriptor.incomplete', { retryable: false, details: { field: missing, toolId: tool.id } }));
      }
      const previous = [...tools.values()].filter(tool => tool.owner === owner);
      for (const tool of previous) tools.delete(tool.id);
      for (const tool of incoming) tools.set(tool.id, freezeDescriptor(tool));
      return ok({ owner, replaced: previous.map(tool => tool.id) });
    },
    /** W2-04：owner 移除（deactivate——只删本 owner 条目，跨 owner 零删除） */
    removeOwner(owner: string) {
      const removed = [...tools.values()].filter(tool => tool.owner === owner).map(tool => tool.id);
      for (const id of removed) tools.delete(id);
      return ok({ owner, removed });
    },
  };
}

export type ToolCatalog = ReturnType<typeof createToolCatalog>;
