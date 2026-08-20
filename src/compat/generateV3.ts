// src/compat/generateV3.ts — V3 兼容清单构建与校验（全量 surface + canonical checksum）
import { createHash } from 'node:crypto';
import type { CompatibilityEntry, CompatibilityManifest } from './schema.js';
import { commandSurface } from './commandSurface.js';
import { protocolSurface } from './protocolSurface.js';
import { configSurface } from './configSurface.js';
import { schemaSurface } from './schemaSurface.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(entries: CompatibilityEntry[]): string {
  return createHash('sha256').update(canonical(entries)).digest('hex');
}

export function buildV3CompatibilityManifest(input: {
  generatedFromCommit: string;
}): CompatibilityManifest {
  const entries = [
    ...commandSurface(),
    ...protocolSurface(),
    ...configSurface(),
    ...schemaSurface(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`COMPAT_DUPLICATE_ID:${entry.id}`);
    ids.add(entry.id);
    if (entry.disposition === 'intentional_break' && !entry.reasonCode) {
      throw new Error(`COMPAT_BREAK_REASON_MISSING:${entry.id}`);
    }
  }
  return {
    schemaVersion: 1,
    generatedFromCommit: input.generatedFromCommit,
    entries,
    checksum: checksum(entries),
  };
}

export function verifyCompatibilityChecksum(
  manifest: CompatibilityManifest,
): { ok: true } | { ok: false; code: 'COMPAT_CHECKSUM_MISMATCH' } {
  return checksum(manifest.entries) === manifest.checksum
    ? { ok: true }
    : { ok: false, code: 'COMPAT_CHECKSUM_MISMATCH' };
}
