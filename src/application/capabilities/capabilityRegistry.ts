// src/application/capabilities/capabilityRegistry.ts — Wave 1 能力注册表：实现 W1-02 CapabilityPort（唯一端口，不重声明）
import { createHash } from 'node:crypto';
import { capabilityUnavailable, type CapabilityId, type CapabilityPort, type CapabilitySnapshot } from '../../domain/capabilities/capability.js';
import { ok } from '../../protocol/results.js';

const states: CapabilitySnapshot['states'] = Object.freeze({ command: 'available', memory: 'available', 'offline-model': 'available',
  voice: 'unavailable', computer: 'unavailable', forge: 'unavailable', distribution: 'unavailable' });

export class Wave1CapabilityRegistry implements CapabilityPort {
  constructor(private readonly policySnapshotId: string, private readonly clock: () => string) {}
  snapshot(): CapabilitySnapshot {
    const generatedAt = this.clock(); const id = createHash('sha256').update(JSON.stringify({ policySnapshotId: this.policySnapshotId, states })).digest('hex');
    return { id, policySnapshotId: this.policySnapshotId, generatedAt, states };
  }
  require(id: CapabilityId) {
    const snapshot = this.snapshot();
    return snapshot.states[id] === 'available' ? ok({ id, snapshotId: snapshot.id }) : capabilityUnavailable(id, snapshot.id);
  }
}
