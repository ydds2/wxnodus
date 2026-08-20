import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NORMATIVE_REDLINE_CATALOG } from '../src/policy/catalog.js';
import {
  buildPolicyManifest,
  verifyPolicyManifestBytes,
} from '../src/policy/snapshot.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'root_home_recursive_destruction',
  'disk_format_partition_raw_write',
  'shutdown_restart_fork_bomb',
  'system_registry_destruction',
  'interpreter_pipe_injection',
  'credential_secret_persistence_leak',
  'unmediated_privilege_key_security_mode_change',
  'remote_history_force_push',
];

describe('Policy Manifest', () => {
  it('covers the normative catalog instead of only snapshotting current regexes', () => {
    const fixture = buildPolicyManifest();
    expect(NORMATIVE_REDLINE_CATALOG.map(category => category.id).sort()).toEqual([...required].sort());
    expect(fixture.categories.every(category => category.normative)).toBe(true);
    for (const category of required) {
      expect(fixture.rules.some(rule => rule.category === category), `POLICY_CATEGORY_MISSING:${category}`).toBe(true);
    }
    expect(fixture.rules.every(rule => rule.overrideable === false)).toBe(true);
    expect(
      fixture.rules.some(rule =>
        rule.category === 'unmediated_privilege_key_security_mode_change' &&
        rule.requiresUserPresence,
      ),
    ).toBe(true);
  });

  it.each([
    ['v3-policy-corrupt.json', 'POLICY_SCHEMA_INVALID'],
    ['v3-policy-truncated.json', 'POLICY_PARSE_FAILED'],
    ['v3-policy-checksum-drift.json', 'POLICY_CHECKSUM_MISMATCH'],
  ])('keeps %s as a later fail-closed consumer fixture', (name, code) => {
    const fixture = readFileSync(resolve(repoRoot, `tests/fixtures/policy/${name}`));
    const result = verifyPolicyManifestBytes(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`EXPECTED_POLICY_FIXTURE_FAILURE:${name}`);
    expect(result.code).toBe(code);
  });
});
