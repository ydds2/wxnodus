// src/infrastructure/plugins/pluginProtocol.ts — Plugin broker：声明能力封装为 BrokerRequest，经 W1 pipeline/PDP/budget/journal
import type { OperationContext } from '../../protocol/operationContext.js';
import type { OperationResult } from '../../protocol/results.js';
import type { ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';

export type BrokerRequest =
  | { id: string; kind: 'workspace.read'; path: string }
  | { id: string; kind: 'workspace.write'; path: string; bytesBase64: string }
  | { id: string; kind: 'network.fetch'; url: string; method: 'GET' | 'POST' }
  | { id: string; kind: 'process.spawn'; executable: string; args: string[] };

export interface BrokerResponse {
  requestId: string;
  receiptId: string;
}

export interface PluginBroker {
  request(
    pluginId: string,
    request: BrokerRequest,
    context: OperationContext,
    signal: AbortSignal,
  ): Promise<OperationResult<BrokerResponse>>;
}

const capabilityTool = {
  'workspace.read': 'builtin:workspace.read',
  'workspace.write': 'builtin:workspace.write',
  'network.fetch': 'builtin:network.fetch',
  'process.spawn': 'builtin:process.spawn',
} as const;

export function createPluginBroker(options: { pipeline: ToolExecutionPipeline }): PluginBroker {
  return {
    async request(pluginId, request, context, signal) {
      void pluginId; // 生产由 pipeline 的 OperationContext.actorId 承载 owner；此处保留接口语义
      if (!request.id || !(request.kind in capabilityTool)) {
        return {
          ok: false,
          error: {
            code: 'PLUGIN_BROKER_REQUEST_INVALID',
            message: 'Invalid broker request',
            messageKey: 'PLUGIN_BROKER_REQUEST_INVALID',
            retryable: false,
          },
        };
      }
      const result = await options.pipeline.execute({
        id: request.id,
        toolId: capabilityTool[request.kind] as never,
        args: request,
      }, context, signal);
      if (!result.ok) return result;
      return {
        ok: true,
        value: { requestId: request.id, receiptId: result.value.effectId },
        evidenceIds: result.evidenceIds,
      };
    },
  };
}
