// src/domain/tools/toolDescriptor.ts — 工具描述符（含副作用/取消/幂等/证据元数据）
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolId } from './toolIds.js';

export interface ToolDescriptor {
  id: ToolId;
  owner: string;
  inputSchema: Record<string, unknown>;
  effects: readonly EffectDescriptor[];
  timeoutMs: number;
  cancellation: 'required' | 'supported' | 'unsupported';
  idempotency: 'idempotent' | 'conditional' | 'non_idempotent';
  evidenceProducer: boolean;
}
