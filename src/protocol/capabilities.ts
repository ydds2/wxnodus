// src/protocol/capabilities.ts — 能力 RPC：capabilities.get 返回 CapabilitySnapshot（注入 CapabilityPort，禁止 handler 自建 probe）
import type { CapabilityPort } from '../domain/capabilities/capability.js';
import type { OperationResult } from './results.js';

export type RpcHandler = (params: Record<string, unknown>) => Promise<OperationResult<unknown>>;

export function createCapabilityRpcHandlers(port: CapabilityPort): Record<string, RpcHandler> {
  return {
    'capabilities.get': async () => ({ ok: true, value: port.snapshot() }),
  };
}
