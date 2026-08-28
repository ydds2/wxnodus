// src/application/capabilities/capabilityRegistry.ts — 能力注册表（Wave1 兼容类 + Wave2 扩展类，同一 CapabilityPort）
import { createHash } from 'node:crypto';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { ProbeRegistry } from '../../infrastructure/capabilities/probeRegistry.js';
import type { CapabilityDescriptor, CapabilityId, CapabilityPort, CapabilitySnapshot } from '../../domain/capabilities/capability.js';

const IDS: CapabilityId[] = ['command','memory','offline-model','session','build','verify','evidence','browser',
  'voice','computer','forge','distribution','mcp-client','mcp-server','skill','plugin','task','subagent'];
const WAVE2_FENCED_SURFACES = new Set<CapabilityId>(['browser','computer','forge']); // A-S3：build/verify/evidence 解 fence（交付）

/** 由 descriptors 生成确定性 snapshot id（key 序固定：policySnapshotId/profile/platform/descriptors） */
function snapshotIdOf(input: { policySnapshotId: string; profile: CapabilitySnapshot['profile']; platform: NodeJS.Platform; descriptors: Record<CapabilityId, CapabilityDescriptor> }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function fenced(options: { profile: CapabilitySnapshot['profile']; platform: NodeJS.Platform }, id: CapabilityId): CapabilityDescriptor {
  return { id, profile: options.profile, platform: options.platform, requirement: 'unavailable',
    state: 'unavailable', delivered: false, stableStatus: 'NOT_DELIVERED', unlockGate: 'W3_OR_LATER_REQUIRED_GATE',
    reasonCode: 'NOT_DELIVERED', source: 'wave2-surface-fence', checksum: '0'.repeat(64) };
}

/**
 * Wave 1 兼容注册表（W1-11 构造签名不变）：
 * 七项基础能力（command/memory/offline-model 可用；voice/computer/forge/distribution 不可达），
 * 其余 W2 扩展 id 全部 NOT_DELIVERED fence——仍是同一 CapabilityPort 实例语义。
 */
export class Wave1CapabilityRegistry implements CapabilityPort {
  private readonly value: CapabilitySnapshot;
  constructor(policySnapshotId: string, clock: () => string, availableExtra: readonly CapabilityId[] = []) {
    const profile: CapabilitySnapshot['profile'] = 'standard';
    const platform: NodeJS.Platform = process.platform;
    const descriptors = {} as Record<CapabilityId, CapabilityDescriptor>;
    const extra = new Set(availableExtra); // A-S3：调用方声明额外可用面（cli 注入 build/verify/evidence/session）
    for (const id of IDS) {
      if (id === 'command' || id === 'memory' || id === 'offline-model' || extra.has(id)) {
        descriptors[id] = { id, profile, platform, requirement: 'required', state: 'available',
          delivered: true, stableStatus: 'DELIVERED', source: 'wave1-registry', checksum: '0'.repeat(64) };
      } else if (id === 'voice' || id === 'computer' || id === 'forge' || id === 'distribution') {
        descriptors[id] = { id, profile, platform, requirement: 'unavailable', state: 'unavailable',
          delivered: false, stableStatus: 'NOT_DELIVERED', unlockGate: 'W3_OR_LATER_REQUIRED_GATE',
          reasonCode: 'NOT_DELIVERED', source: 'wave1-registry', checksum: '0'.repeat(64) };
      } else {
        descriptors[id] = fenced({ profile, platform }, id);
      }
    }
    const states = Object.fromEntries(IDS.map(id => [id, descriptors[id].state])) as Record<CapabilityId, CapabilityDescriptor['state']>;
    const id = snapshotIdOf({ policySnapshotId, profile, platform, descriptors });
    this.value = Object.freeze({
      id,
      policySnapshotId,
      generatedAt: clock(),
      profile,
      platform,
      states: Object.freeze(states),
      descriptors: Object.freeze(descriptors),
    });
  }
  snapshot(): CapabilitySnapshot { return this.value; }
  require(id: CapabilityId) {
    const descriptor = this.value.descriptors[id];
    return descriptor.state === 'available'
      ? ok({ id, snapshotId: this.value.id })
      : err(gatewayError('CAPABILITY_UNAVAILABLE', `能力不可用：${id}`, 'capability.unavailable', {
        retryable: false,
        details: { capabilityId: id, snapshotId: this.value.id, state: descriptor.state, reasonCode: descriptor.stableStatus },
      }));
  }
}

type Requirement = CapabilityDescriptor['requirement'];
interface Wave2Options {
  policySnapshotId: string;
  profile: CapabilitySnapshot['profile'];
  platform: NodeJS.Platform;
  clock(): string;
  probes: ProbeRegistry;
  requirements: Partial<Record<CapabilityId, Requirement>>;
}

/** Wave 2 注册表：Wave1 fence 升级——fenced surface 不跑 probe，required probe 失败 → blocked */
export class Wave2CapabilityRegistry implements CapabilityPort {
  private constructor(private readonly value: CapabilitySnapshot) {}
  static async create(options: Wave2Options): Promise<Wave2CapabilityRegistry> {
    const descriptors = {} as Record<CapabilityId, CapabilityDescriptor>;
    for (const id of IDS) {
      if (WAVE2_FENCED_SURFACES.has(id)) {
        descriptors[id] = fenced({ profile: options.profile, platform: options.platform }, id);
        continue;
      }
      const requirement = options.requirements[id] ?? 'unavailable';
      if (requirement === 'unavailable') {
        descriptors[id] = { id, profile: options.profile, platform: options.platform, requirement,
          state: 'unavailable', delivered: false, stableStatus: 'NOT_DELIVERED', reasonCode: 'CAPABILITY_UNAVAILABLE',
          source: 'wave2-policy', checksum: '0'.repeat(64) };
        continue;
      }
      const probe = await options.probes.run(id);
      descriptors[id] = { id, profile: options.profile, platform: options.platform, requirement,
        state: probe.ok ? 'available' : requirement === 'required' ? 'blocked' : 'degraded',
        delivered: probe.ok, stableStatus: probe.ok ? 'DELIVERED' : 'NOT_DELIVERED',
        reasonCode: probe.ok ? undefined : requirement === 'required' ? 'CAPABILITY_BLOCKED' : 'CAPABILITY_PROBE_FAILED',
        source: probe.source, checksum: probe.checksum };
    }
    const states = Object.fromEntries(IDS.map(id => [id, descriptors[id].state])) as Record<CapabilityId, CapabilityDescriptor['state']>;
    const id = snapshotIdOf({ policySnapshotId: options.policySnapshotId, profile: options.profile, platform: options.platform, descriptors });
    return new Wave2CapabilityRegistry(Object.freeze({
      id,
      policySnapshotId: options.policySnapshotId,
      generatedAt: options.clock(),
      profile: options.profile,
      platform: options.platform,
      states: Object.freeze(states),
      descriptors: Object.freeze(descriptors),
    }));
  }
  snapshot(): CapabilitySnapshot { return this.value; }
  require(id: CapabilityId) {
    const descriptor = this.value.descriptors[id];
    return descriptor.state === 'available'
      ? ok({ id, snapshotId: this.value.id })
      : err(gatewayError(descriptor.state === 'blocked' ? 'CAPABILITY_BLOCKED' : 'CAPABILITY_UNAVAILABLE',
          id, 'capability.unavailable', { retryable: false, details: { capabilityId: id, snapshotId: this.value.id,
            state: descriptor.state, reasonCode: descriptor.stableStatus } }));
  }
}
