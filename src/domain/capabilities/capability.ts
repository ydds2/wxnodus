// src/domain/capabilities/capability.ts — CapabilityPort（W1-02 定义；W2-03 扩展 union/snapshot，不重声明端口）
import { gatewayError } from '../../protocol/errors.js';
import { err, type OperationResult } from '../../protocol/results.js';

export type CapabilityId = 'command' | 'memory' | 'offline-model' | 'session' | 'build' | 'verify' |
  'evidence' | 'browser' | 'voice' | 'computer' | 'forge' | 'distribution' |
  'mcp-client' | 'mcp-server' | 'skill' | 'plugin' | 'task' | 'subagent';

export type CapabilityState = 'available' | 'degraded' | 'unavailable' | 'blocked';

export interface CapabilityDescriptor {
  id: CapabilityId;
  profile: 'core' | 'standard' | 'full-local-ai';
  platform: NodeJS.Platform;
  requirement: 'required' | 'optional' | 'unavailable';
  state: CapabilityState;
  delivered: boolean;
  stableStatus: 'DELIVERED' | 'NOT_DELIVERED';
  unlockGate?: 'W3_OR_LATER_REQUIRED_GATE';
  reasonCode?: 'NOT_DELIVERED' | 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_BLOCKED' | 'CAPABILITY_PROBE_FAILED';
  source: string;
  checksum: string;
}

export interface CapabilitySnapshot {
  id: string;
  policySnapshotId: string;
  generatedAt: string;
  profile: 'core' | 'standard' | 'full-local-ai';
  platform: NodeJS.Platform;
  states: Readonly<Record<CapabilityId, CapabilityState>>;
  descriptors: Readonly<Record<CapabilityId, CapabilityDescriptor>>;
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
