// src/domain/extensions/pluginManifest.ts — Plugin manifest 解析/校验（safe name 复用 W2-07 唯一规则）
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeExtensionName } from '../safeNames.js';

export interface PluginCapabilityRequest { kind: 'workspace.read' | 'workspace.write' | 'network.fetch' | 'process.spawn' }
export interface SignatureDescriptor { issuer: string; keyId: string; value: string }

export interface PluginManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  entrypoint: string;
  trustLevel: 'trusted' | 'untrusted';
  permissions: PluginCapabilityRequest[];
  checksum: string;
  signature?: SignatureDescriptor;
}

export class PluginManifestError extends Error {
  constructor(readonly code: 'PLUGIN_MANIFEST_INVALID' | 'PLUGIN_CHECKSUM_MISMATCH', readonly source: string, message: string, cause?: unknown) {
    super(`${code}:${source}:${message}`, { cause });
    this.name = 'PluginManifestError';
  }
}

export function parsePluginManifest(text: string, source: string): PluginManifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new PluginManifestError('PLUGIN_MANIFEST_INVALID', source, 'manifest is not JSON', cause);
  }
  const name = String(raw.name ?? '');
  try {
    assertSafeExtensionName(name);
  } catch (cause) {
    throw new PluginManifestError('PLUGIN_MANIFEST_INVALID', source, `unsafe plugin name: ${name}`, cause);
  }
  const trustLevel = raw.trustLevel;
  if (trustLevel !== 'trusted' && trustLevel !== 'untrusted') {
    throw new PluginManifestError('PLUGIN_MANIFEST_INVALID', source, 'trustLevel must be trusted|untrusted');
  }
  const permissions = raw.permissions;
  if (!Array.isArray(permissions) || permissions.some(p => !['workspace.read', 'workspace.write', 'network.fetch', 'process.spawn'].includes(String(p?.kind)))) {
    throw new PluginManifestError('PLUGIN_MANIFEST_INVALID', source, 'permissions must be capability requests');
  }
  const checksum = String(raw.checksum ?? '');
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new PluginManifestError('PLUGIN_MANIFEST_INVALID', source, 'checksum must be lowercase SHA-256');
  return {
    schemaVersion: raw.schemaVersion === 1 ? 1 : (() => { throw new PluginManifestError('PLUGIN_MANIFEST_INVALID', source, 'schemaVersion must be 1'); })(),
    name,
    version: String(raw.version ?? ''),
    entrypoint: String(raw.entrypoint ?? ''),
    trustLevel,
    permissions: permissions.map(p => ({ kind: (p as { kind: PluginCapabilityRequest['kind'] }).kind })),
    checksum,
    signature: raw.signature === undefined ? undefined : raw.signature as SignatureDescriptor,
  };
}

export function verifyPluginChecksum(dir: string, manifest: PluginManifest): void {
  const entrypoint = join(dir, manifest.entrypoint);
  const actual = createHash('sha256').update(readFileSync(entrypoint)).digest('hex');
  if (actual !== manifest.checksum) {
    throw new PluginManifestError('PLUGIN_CHECKSUM_MISMATCH', entrypoint, `expected ${manifest.checksum}, got ${actual}`);
  }
}
