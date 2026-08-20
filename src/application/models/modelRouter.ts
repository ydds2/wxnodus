// src/application/models/modelRouter.ts — 模型路由：先匹配 provider 再查 key（离线路径不被 key gate 拦截）
import type { ModelInferenceRequest, ModelProvider } from '../../domain/models/modelProvider.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err } from '../../protocol/results.js';

export class ModelRouter {
  constructor(private readonly providers: ModelProvider[]) {}
  async infer(request: ModelInferenceRequest, context: OperationContext, apiKey: string | null, signal: AbortSignal) {
    const provider = this.providers.find(candidate => candidate.supports(request.modelId));
    if (!provider) return err(gatewayError('MODEL_PROVIDER_NOT_FOUND', request.modelId, 'model.provider.notFound'));
    if (provider.descriptor.requiresApiKey && !apiKey) return err(gatewayError('MODEL_API_KEY_REQUIRED', 'API key required', 'model.apiKey.required'));
    return provider.infer(request, context, apiKey, signal);
  }
}
