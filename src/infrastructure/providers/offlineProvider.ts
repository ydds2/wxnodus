// src/infrastructure/providers/offlineProvider.ts — 离线模型提供方：无 key 可达，文本永不当工具调用
import type { ModelInferenceRequest, ModelInferenceResponse, ModelProvider } from '../../domain/models/modelProvider.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import type { OperationResult } from '../../protocol/results.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

type Adapter = { isReady(modelId: string): boolean;
  infer(modelId: string, request: ModelInferenceRequest, signal: AbortSignal): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> };

export class OfflineProvider implements ModelProvider {
  readonly descriptor = { id: 'offline', modelPrefix: 'offline:', requiresApiKey: false,
    capabilities: { streaming: true, toolCalls: false, vision: false } } as const;
  constructor(private readonly adapter: Adapter) {}
  supports(modelId: string) { return modelId.startsWith(this.descriptor.modelPrefix); }
  async infer(request: ModelInferenceRequest, _context: OperationContext, _apiKey: string | null, signal: AbortSignal): Promise<OperationResult<ModelInferenceResponse>> {
    if (!this.adapter.isReady(request.modelId)) return err(gatewayError('OFFLINE_MODEL_NOT_READY', 'Offline model is not ready', 'offline.notReady'));
    if (request.tools?.length) return err(gatewayError('MODEL_TOOL_CALL_UNSUPPORTED', 'Offline provider does not support tools', 'model.tools.unsupported'));
    if (signal.aborted) return err(gatewayError('MODEL_INFERENCE_CANCELLED', 'Inference cancelled', 'model.cancelled'));
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'MODEL_INFERENCE_TIMEOUT' })), request.timeoutMs ?? 120_000); });
      const value = await Promise.race([this.adapter.infer(request.modelId, request, signal), timeout]);
      if (signal.aborted) return err(gatewayError('MODEL_INFERENCE_CANCELLED', 'Inference cancelled', 'model.cancelled'));
      if (!value.content.trim()) return err(gatewayError('MODEL_EMPTY_RESPONSE', 'Model returned empty content', 'model.empty'));
      const usage = typeof value.promptTokens === 'number' && typeof value.completionTokens === 'number'
        ? { kind: 'estimated' as const, promptTokens: value.promptTokens, completionTokens: value.completionTokens }
        : { kind: 'unavailable' as const, reasonCode: 'OFFLINE_USAGE_UNAVAILABLE' };
      return ok({ modelId: request.modelId, content: value.content, toolCalls: [], usage });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (signal.aborted) return err(gatewayError('MODEL_INFERENCE_CANCELLED', 'Inference cancelled', 'model.cancelled'));
      if (code === 'MODEL_INFERENCE_TIMEOUT' || code === 'OFFLINE_MODEL_LOAD_FAILED') return err(gatewayError(code, code, `model.${code}`));
      return err(gatewayError('MODEL_INFERENCE_FAILED', 'Offline inference failed', 'model.inference.failed'));
    } finally { if (timer) clearTimeout(timer); }
  }
}
