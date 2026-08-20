// src/domain/models/modelProvider.ts — 模型提供方端口：descriptor 路由 + 稳定错误码
import type { ChatMessage } from '../../kernel/providers.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import type { OperationResult } from '../../protocol/results.js';

export interface ModelProviderDescriptor { id: string; modelPrefix: string; requiresApiKey: boolean;
  capabilities: { streaming: boolean; toolCalls: boolean; vision: boolean } }
export interface ModelInferenceRequest { modelId: string; messages: ChatMessage[]; timeoutMs?: number; tools?: unknown[] }
export interface ModelInferenceResponse { modelId: string; content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: { kind: 'measured' | 'estimated'; promptTokens: number; completionTokens: number } | { kind: 'unavailable'; reasonCode: string } }
export interface ModelProvider { descriptor: ModelProviderDescriptor; supports(modelId: string): boolean;
  infer(request: ModelInferenceRequest, context: OperationContext, apiKey: string | null, signal: AbortSignal): Promise<OperationResult<ModelInferenceResponse>> }
