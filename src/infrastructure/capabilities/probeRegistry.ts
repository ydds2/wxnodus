// src/infrastructure/capabilities/probeRegistry.ts — 能力探测注册表：计数 + missing probe 确定性失败
import type { CapabilityId } from '../../domain/capabilities/capability.js';

export interface ProbeResult { ok: boolean; source: string; checksum: string }
export type CapabilityProbe = () => Promise<ProbeResult>;

export class ProbeRegistry {
  private readonly counts = new Map<CapabilityId, number>();
  constructor(private readonly probes: Partial<Record<CapabilityId, CapabilityProbe>>) {}
  async run(id: CapabilityId): Promise<ProbeResult> {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    const probe = this.probes[id];
    return probe ? probe() : { ok: false, source: 'probe:missing', checksum: '0'.repeat(64) };
  }
  calls(id: CapabilityId): number { return this.counts.get(id) ?? 0; }
}
