import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SLASH } from '../src/commands/registry.js';
import { ALIASES } from '../src/kernel/commandLevels.js';
import {
  buildV3CompatibilityManifest,
  verifyCompatibilityChecksum,
} from '../src/compat/generateV3.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('V3 compatibility manifest', () => {
  it('covers the runtime surface without protecting known false-success behavior', () => {
    const fixture = buildV3CompatibilityManifest({ generatedFromCommit: 'test-fixture' });
    const names = new Set(fixture.entries.map(entry => `${entry.kind}:${entry.name}`));

    for (const command of SLASH) {
      expect(names.has(`slash:${command}`), `COMPAT_SURFACE_MISSING:slash:${command}`).toBe(true);
    }
    for (const alias of Object.keys(ALIASES)) {
      expect(names.has(`slash:alias:${alias}`), `COMPAT_SURFACE_MISSING:slash:alias:${alias}`).toBe(true);
    }

    const invalidPreserves = fixture.entries.filter(entry =>
      entry.disposition === 'preserve' &&
      ['false_success', 'fail_open_security', 'unknown_flag_ignored'].includes(entry.reasonCode ?? ''),
    );
    expect(invalidPreserves).toEqual([]);
    expect(verifyCompatibilityChecksum(fixture)).toEqual({ ok: true });
  });

  it('produces a Gate D input fixture, not Gate D evidence', () => {
    const path = resolve(repoRoot, 'tests/fixtures/gates/gate-d-v3-compatibility.json');
    const gateFixture = JSON.parse(readFileSync(path, 'utf8')) as {
      purpose: string;
      evidenceStatus?: string;
      manifestPath: string;
    };

    expect(gateFixture.purpose).toBe('gate_d_input_fixture_only');
    expect(gateFixture.evidenceStatus).toBeUndefined();
    expect(gateFixture.manifestPath).toBe('docs/superpowers/manifests/v3-compatibility.json');
  });
});
