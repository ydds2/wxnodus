// src/release/wave0EvidenceContext.ts — Wave 0 environment/artifact/policy 一次性上下文（runner 与 drill 同源）
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { verifyPolicyManifestBytes } from '../policy/snapshot.js';
import { computeEvidenceBindingSha256 } from './artifactBinding.js';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface Wave0EvidenceContext {
  repoRoot: string;
  commit: string;
  environmentHash: string;
  artifactHash: string;
  policyHash: string;
  policyChecksum: string;
  bindingSha256: string;
}

/** 生成（或重生成）environment.json / candidate-artifact.json 并返回完整上下文。
 *  refresh=false：文件已存在时只读不写（drill 复用 gate runner 已生成的一致快照）。 */
export function prepareWave0EvidenceContext(repoRoot: string, refresh = true): Wave0EvidenceContext {
  const evidenceDir = resolve(repoRoot, 'docs/superpowers/evidence/wave0');
  const attachmentsDir = resolve(evidenceDir, 'attachments');
  mkdirSync(attachmentsDir, { recursive: true });

  const commit = (() => {
    try {
      return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();

  const environmentPath = resolve(attachmentsDir, 'environment.json');
  const artifactPath = resolve(evidenceDir, 'candidate-artifact.json');

  if (!refresh && existsSync(environmentPath) && existsSync(artifactPath)) {
    const environmentHash = sha256(readFileSync(environmentPath));
    const artifactHash = sha256(readFileSync(artifactPath));
    const policyPath = resolve(repoRoot, 'docs/superpowers/manifests/v3-policy.json');
    const policyBytes = readFileSync(policyPath);
    const policyHash = sha256(policyBytes);
    const policyVerify = verifyPolicyManifestBytes(policyBytes);
    if (!policyVerify.ok) throw new Error(`POLICY_MANIFEST_INVALID:${policyPath}`);
    const policyChecksum = policyVerify.manifest.checksum;
    const bindingSha256 = computeEvidenceBindingSha256({
      environmentSha256: environmentHash,
      policyManifestSha256: policyHash,
      policyManifestChecksum: policyChecksum,
      artifactSha256: artifactHash,
      commit,
    });
    return { repoRoot, commit, environmentHash, artifactHash, policyHash, policyChecksum, bindingSha256 };
  }

  const environmentText = JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: `${process.platform} ${process.arch}`,
    repoRoot,
    commit,
    generatedAt: new Date().toISOString(),
  }, null, 2);
  writeFileSync(environmentPath, environmentText);
  const environmentHash = sha256(Buffer.from(environmentText, 'utf8'));

  const artifactText = JSON.stringify({
    wave: 'wave0',
    kind: 'V3 compatibility baseline',
    commit,
    generatedAt: new Date().toISOString(),
  }, null, 2);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, artifactText);
  const artifactHash = sha256(Buffer.from(artifactText, 'utf8'));

  const policyPath = resolve(repoRoot, 'docs/superpowers/manifests/v3-policy.json');
  const policyBytes = readFileSync(policyPath);
  const policyHash = sha256(policyBytes);
  const policyVerify = verifyPolicyManifestBytes(policyBytes);
  if (!policyVerify.ok) throw new Error(`POLICY_MANIFEST_INVALID:${policyPath}`);
  const policyChecksum = policyVerify.manifest.checksum;

  const bindingSha256 = computeEvidenceBindingSha256({
    environmentSha256: environmentHash,
    policyManifestSha256: policyHash,
    policyManifestChecksum: policyChecksum,
    artifactSha256: artifactHash,
    commit,
  });

  return { repoRoot, commit, environmentHash, artifactHash, policyHash, policyChecksum, bindingSha256 };
}
