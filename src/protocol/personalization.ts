// src/protocol/personalization.ts — 个性化 RPC handlers：真实 service 委托 + 全量配置脱敏
import type { ConfigScope } from '../domain/config/configSchema.js';
import type { OperationResult } from './results.js';
import type { PersonalizationService } from '../application/personalization/personalizationService.js';

export type RpcHandler = (params: Record<string, unknown>) => Promise<OperationResult<unknown>>;

function redact(value: unknown, key = ''): unknown {
  if (/secret|token|password|apiKey/i.test(key) && !/Ref$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function createPersonalizationRpcHandlers(options: {
  service: PersonalizationService;
  readFullConfig(): Promise<Record<string, unknown>>;
}): Record<string, RpcHandler> {
  const mutate = async (params: Record<string, unknown>): Promise<OperationResult<unknown>> => {
    const scope: ConfigScope = params.scope === 'workspace' ? 'workspace' : 'user';
    return options.service.update(scope, params.patch ?? {});
  };
  return {
    'personalization.get': async params => options.service.get(params.scope === 'workspace' ? 'workspace' : 'user'),
    'personalization.update': mutate,
    'personalization.setup': mutate,
    'personalization.export': async params => options.service.export(params.scope === 'workspace' ? 'workspace' : 'user'),
    'personalization.import': async params => options.service.import(params.scope === 'workspace' ? 'workspace' : 'user', params.value),
    'config.getFull': async () => ({ ok: true, value: redact(await options.readFullConfig()) }),
  };
}
