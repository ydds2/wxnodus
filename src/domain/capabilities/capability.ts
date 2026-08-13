// src/domain/capabilities/capability.ts — CapabilityPort（W1-11 实现 registry；本任务只定义端口）
import { gatewayError } from '../../protocol/errors.js';
import { err, type OperationResult } from '../../protocol/results.js';

export type CapabilityId = 'command' | 'memory' | 'offline-model' | 'voice' | 'computer' | 'forge' | 'distribution';

export interface CapabilitySnapshot {
  id: string;
  policySnapshotId: string;
  generatedAt: string;
  states: Readonly<Record<CapabilityId, 'available' | 'unavailable'>>;
}

export interface CapabilityPort {
  snapshot(): CapabilitySnapshot;
  require(id: CapabilityId): OperationResult<{ id: CapabilityId; snapshotId: string }>;
}

export function capabilityUnavailable(id: CapabilityId, snapshotId: string): OperationResult<never> {
  return err(gatewayError('CAPABILITY_UNAVAILABLE', `能力不可用：${id}`, 'capability.unavailable', {
    retryable: false,
    details: { capabilityId: id, snapshotId },
  }));
}
