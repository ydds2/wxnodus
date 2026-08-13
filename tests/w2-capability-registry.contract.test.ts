import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Wave2CapabilityRegistry } from '../src/application/capabilities/capabilityRegistry.js';
import type { CapabilityPort } from '../src/domain/capabilities/capability.js';
import { ProbeRegistry } from '../src/infrastructure/capabilities/probeRegistry.js';

const checksum = (value: string) => createHash('sha256').update(value).digest('hex');

describe('W2-03 extends the W1-11 CapabilityRegistry', () => {
  it('maps required/optional/unavailable deterministically and preserves W1 CapabilityPort', async () => {
    const probes = new ProbeRegistry({
      command: async () => ({ ok: false, source: 'fixture:command', checksum: checksum('command') }),
      browser: async () => ({ ok: false, source: 'fixture:browser', checksum: checksum('browser') }),
      computer: vi.fn(async () => ({ ok: true, source: 'fixture:installed', checksum: checksum('installed') })),
    });
    const registry: CapabilityPort = await Wave2CapabilityRegistry.create({
      policySnapshotId: 'policy-2', profile: 'standard', platform: 'win32',
      clock: () => '2026-08-13T00:00:00.000Z', probes,
      requirements: { command: 'required', browser: 'unavailable', computer: 'unavailable' },
    });

    expect(registry.require('command')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_BLOCKED' } });
    expect(registry.require('browser')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', details: { reasonCode: 'NOT_DELIVERED' } } });
    expect(registry.require('computer')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', details: { reasonCode: 'NOT_DELIVERED' } } });
    expect(probes.calls('browser')).toBe(0);
    expect(probes.calls('computer')).toBe(0);

    const first = registry.snapshot();
    const second = registry.snapshot();
    expect(first.id).toBe(second.id);
    for (const id of ['build','verify','evidence','browser','computer','forge'] as const) {
      expect(first.descriptors[id]).toMatchObject({ delivered: false, stableStatus: 'NOT_DELIVERED',
        requirement: 'unavailable', state: 'unavailable', reasonCode: 'NOT_DELIVERED',
        source: 'wave2-surface-fence', unlockGate: 'W3_OR_LATER_REQUIRED_GATE' });
      expect(registry.require(id)).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE',
        details: { capabilityId: id, reasonCode: 'NOT_DELIVERED' } } });
    }
    expect(first.descriptors.computer).toMatchObject({
      profile: 'standard', platform: 'win32', requirement: 'unavailable', state: 'unavailable',
      delivered: false, stableStatus: 'NOT_DELIVERED', reasonCode: 'NOT_DELIVERED', source: 'wave2-surface-fence',
    });
    expect(first.id).toBe(checksum(JSON.stringify({
      policySnapshotId: first.policySnapshotId,
      profile: first.profile,
      platform: first.platform,
      descriptors: first.descriptors,
    })));
  });
});
