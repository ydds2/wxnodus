// src/release/artifactBinding.ts — artifact binding 与 attachment 验证
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { EvidenceAttachment, Sha256 } from './evidenceTypes.js';
import type { GateEvidenceErrorCode } from './evidenceSchema.js';

export function sha256File(path: string): Sha256 {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeEvidenceBindingSha256(input: {
  environmentSha256: Sha256;
  policyManifestSha256: Sha256;
  policyManifestChecksum: Sha256;
  artifactSha256: Sha256;
  commit: string;
}): Sha256 {
  return createHash('sha256').update(canonicalJson({
    environmentSha256: input.environmentSha256,
    policyManifestSha256: input.policyManifestSha256,
    policyManifestChecksum: input.policyManifestChecksum,
    artifactSha256: input.artifactSha256,
    commit: input.commit,
  })).digest('hex');
}

export function verifyEvidenceAttachments(
  repoRoot: string,
  attachments: EvidenceAttachment[],
): { ok: true } | { ok: false; code: GateEvidenceErrorCode } {
  const seen = new Set<string>();
  for (const attachment of attachments) {
    if (!attachment.path || isAbsolute(attachment.path) || attachment.path.includes('..') || attachment.path.includes('\\')) {
      return { ok: false, code: 'GATE_ATTACHMENT_PATH_INVALID' };
    }
    if (seen.has(attachment.path)) return { ok: false, code: 'GATE_ATTACHMENT_DUPLICATE' };
    seen.add(attachment.path);
    const resolvedPath = resolve(repoRoot, attachment.path);
    if (!resolvedPath.startsWith(resolve(repoRoot))) return { ok: false, code: 'GATE_ATTACHMENT_PATH_INVALID' };
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) return { ok: false, code: 'GATE_ATTACHMENT_MISSING' };
    if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) return { ok: false, code: 'GATE_HASH_FORMAT_INVALID' };
    if (sha256File(resolvedPath) !== attachment.sha256) return { ok: false, code: 'GATE_ATTACHMENT_HASH_MISMATCH' };
  }
  return { ok: true };
}
