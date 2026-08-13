// src/infrastructure/providers/cloudProvider.ts — 云端兼容提供方：必须先有 key
import type { ModelInferenceRequest, ModelProvider } from '../../domain/models/modelProvider.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err } from '../../protocol/results.js';

export class CloudProvider implements ModelProvider {
  readonly descriptor = { id: 'cloud-openai-compatible', modelPrefix: '', requiresApiKey: true,
    capabilities: { streaming: true, toolCalls: true, vision: true } } as const;
  constructor(private readonly adapter: { infer(request: ModelInferenceRequest, key: string, signal: AbortSignal): Promise<any> }) {}
  supports(modelId: string) { return !modelId.startsWith('offline:'); }
  async infer(request: ModelInferenceRequest, _context: OperationContext, apiKey: string | null, signal: AbortSignal) {
    if (!apiKey) return err(gatewayError('MODEL_API_KEY_REQUIRED', 'API key required', 'model.apiKey.required'));
    return this.adapter.infer(request, apiKey, signal);
  }
}
