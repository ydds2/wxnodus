// src/release/evidenceSchema.ts — GateEvidence 严格运行时判别联合验证（类型接口不能充当验证器）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { verifyPolicyManifestBytes } from '../policy/snapshot.js';
import type { EvidenceAttachment, GateEvidence, GateId, MigrationDrillBinding, Sha256 } from './evidenceTypes.js';

export type {
  GateId,
  Sha256,
  ProfileId,
  PlatformId,
  EvidenceAttachment,
  EvidenceBinding,
  CommandEvidence,
  ExecutedGateEvidence,
  NotApplicableGateEvidence,
  GateEvidence,
  MigrationDrillBinding,
} from './evidenceTypes.js';

export type GateEvidenceErrorCode =
  | 'GATE_EVIDENCE_INVALID'
  | 'GATE_NA_SCOPE_MISSING'
  | 'GATE_EXECUTION_SCOPE_MISSING'
  | 'GATE_STATUS_SHAPE_INVALID'
  | 'GATE_PASSED_COMMAND_NONZERO'
  | 'GATE_ATTACHMENT_PATH_INVALID'
  | 'GATE_ATTACHMENT_DUPLICATE'
  | 'GATE_ATTACHMENT_MISSING'
  | 'GATE_COMMAND_ATTACHMENT_MISSING'
  | 'GATE_HASH_FORMAT_INVALID'
  | 'GATE_ATTACHMENT_HASH_MISMATCH'
  | 'GATE_BINDING_MISSING'
  | 'GATE_POLICY_MANIFEST_INVALID'
  | 'GATE_BINDING_HASH_MISMATCH'
  | 'GATE_C_CURRENT_ARTIFACT_MISMATCH';

const GATES: GateId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const PROFILES = ['core', 'standard', 'full-local-ai'];
const PLATFORMS = ['windows', 'linux', 'macos'];
const ATTACH_KINDS = ['stdout', 'stderr', 'artifact', 'environment', 'policy-manifest', 'migration-drill', 'unreachable-capability'];
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMON_KEYS = ['schemaVersion', 'waveScope', 'gate', 'requirementIds', 'profiles', 'platforms', 'capabilityIds', 'attachments', 'binding', 'status'];
const COMMAND_KEYS = ['executable', 'args', 'exitCode', 'stdoutAttachment', 'stderrAttachment'];
const ATTACH_KEYS = ['path', 'sha256', 'kind'];
const BINDING_KEYS = ['environment', 'policyManifest', 'artifact', 'bindingSha256'];

function fail(code: GateEvidenceErrorCode): { ok: false; code: GateEvidenceErrorCode } {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrArrayUniqueNonEmpty(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.length > 0) &&
    new Set(value).size === value.length;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateAttachment(attachment: unknown, repoRoot: string): { ok: true } | { ok: false; code: GateEvidenceErrorCode } {
  if (!isRecord(attachment)) return fail('GATE_ATTACHMENT_PATH_INVALID');
  for (const key of Object.keys(attachment)) {
    if (!ATTACH_KEYS.includes(key)) return fail('GATE_ATTACHMENT_PATH_INVALID');
  }
  const path = attachment.path;
  const hash = attachment.sha256;
  const kind = attachment.kind;
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('..') || path.includes('\\')) {
    return fail('GATE_ATTACHMENT_PATH_INVALID');
  }
  if (typeof hash !== 'string' || !SHA256_RE.test(hash)) return fail('GATE_HASH_FORMAT_INVALID');
  if (typeof kind !== 'string' || !ATTACH_KINDS.includes(kind)) return fail('GATE_ATTACHMENT_PATH_INVALID');
  const resolvedPath = resolve(repoRoot, path);
  if (!resolvedPath.startsWith(resolve(repoRoot))) return fail('GATE_ATTACHMENT_PATH_INVALID');
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) return fail('GATE_ATTACHMENT_MISSING');
  if (sha256(readFileSync(resolvedPath)) !== hash) return fail('GATE_ATTACHMENT_HASH_MISMATCH');
  return { ok: true };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function computeBindingSha256(input: {
  environmentSha256: string;
  policyManifestSha256: string;
  policyManifestChecksum: string;
  artifactSha256: string;
  commit: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    environmentSha256: input.environmentSha256,
    policyManifestSha256: input.policyManifestSha256,
    policyManifestChecksum: input.policyManifestChecksum,
    artifactSha256: input.artifactSha256,
    commit: input.commit,
  })).digest('hex');
}

export interface GateEvidenceContext {
  repoRoot: string;
  expectedGate: GateId;
  currentArtifact: EvidenceAttachment & { artifactSha256: Sha256; commit: string };
  currentEnvironment: EvidenceAttachment;
  currentPolicyManifest: EvidenceAttachment & { manifestChecksum: Sha256 };
  currentMigrationBinding?: MigrationDrillBinding;
}

export function validateGateEvidence(
  value: unknown,
  context: GateEvidenceContext,
): { ok: true; evidence: GateEvidence } | { ok: false; code: GateEvidenceErrorCode } {
  if (!isRecord(value)) return fail('GATE_EVIDENCE_INVALID');
  const allowed = new Set([...COMMON_KEYS]);
  const status = value.status;
  if (status === 'not_applicable') {
    allowed.add('unreachableEvidenceIds');
    allowed.add('reasonCode');
  } else if (status === 'passed' || status === 'failed' || status === 'blocked') {
    allowed.add('commands');
    if (status === 'failed' || status === 'blocked') allowed.add('reasonCode');
  } else {
    return fail('GATE_EVIDENCE_INVALID');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return fail('GATE_EVIDENCE_INVALID');
  }

  if (value.schemaVersion !== 1) return fail('GATE_EVIDENCE_INVALID');
  if (value.waveScope !== 'wave0') return fail('GATE_EVIDENCE_INVALID');
  if (!GATES.includes(value.gate as GateId) || value.gate !== context.expectedGate) return fail('GATE_EVIDENCE_INVALID');
  if (!isStrArrayUniqueNonEmpty(value.requirementIds) || !value.requirementIds.every(r => /^R\d{2}$/.test(r))) return fail('GATE_EVIDENCE_INVALID');
  if (!isStrArrayUniqueNonEmpty(value.profiles) || !value.profiles.every(p => PROFILES.includes(p))) return fail('GATE_EVIDENCE_INVALID');
  if (!isStrArrayUniqueNonEmpty(value.platforms) || !value.platforms.every(p => PLATFORMS.includes(p))) return fail('GATE_EVIDENCE_INVALID');
  if (!isStrArrayUniqueNonEmpty(value.capabilityIds)) return fail('GATE_EVIDENCE_INVALID');

  const attachments = value.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return fail('GATE_EVIDENCE_INVALID');
  const seenPaths = new Set<string>();
  const attachmentByPath = new Map<string, Record<string, unknown>>();
  for (const attachment of attachments) {
    if (!isRecord(attachment)) return fail('GATE_ATTACHMENT_PATH_INVALID');
    const path = attachment.path;
    if (typeof path !== 'string' || seenPaths.has(path)) return fail('GATE_ATTACHMENT_DUPLICATE');
    seenPaths.add(path);
    const validated = validateAttachment(attachment, context.repoRoot);
    if (!validated.ok) return validated;
    attachmentByPath.set(path, attachment);
  }

  // binding 验证
  const binding = value.binding;
  if (!isRecord(binding)) return fail('GATE_BINDING_MISSING');
  for (const key of Object.keys(binding)) {
    if (!BINDING_KEYS.includes(key)) return fail('GATE_BINDING_MISSING');
  }
  const bindingEnv = binding.environment;
  const bindingPolicy = binding.policyManifest;
  const bindingArtifact = binding.artifact;
  const bindingSha256 = binding.bindingSha256;
  if (!isRecord(bindingEnv) || typeof bindingEnv.path !== 'string' || typeof bindingEnv.sha256 !== 'string' || typeof bindingEnv.kind !== 'string') return fail('GATE_BINDING_MISSING');
  if (!isRecord(bindingPolicy) || typeof bindingPolicy.path !== 'string' || typeof bindingPolicy.sha256 !== 'string' || typeof bindingPolicy.manifestChecksum !== 'string') return fail('GATE_BINDING_MISSING');
  if (!isRecord(bindingArtifact) || typeof bindingArtifact.path !== 'string' || typeof bindingArtifact.sha256 !== 'string' || typeof bindingArtifact.artifactSha256 !== 'string' || typeof bindingArtifact.commit !== 'string') return fail('GATE_BINDING_MISSING');
  if (typeof bindingSha256 !== 'string' || !SHA256_RE.test(bindingSha256)) return fail('GATE_HASH_FORMAT_INVALID');

  // binding 与 context 一致 + attachment 引用存在
  const envMatch = attachmentByPath.get(bindingEnv.path);
  if (!envMatch) return fail('GATE_ATTACHMENT_MISSING');
  if (envMatch.sha256 !== context.currentEnvironment.sha256 || envMatch.sha256 !== bindingEnv.sha256) return fail('GATE_BINDING_HASH_MISMATCH');
  const policyMatch = attachmentByPath.get(bindingPolicy.path);
  if (!policyMatch) return fail('GATE_ATTACHMENT_MISSING');
  if (policyMatch.sha256 !== context.currentPolicyManifest.sha256 || policyMatch.sha256 !== bindingPolicy.sha256) return fail('GATE_BINDING_HASH_MISMATCH');
  const artifactMatch = attachmentByPath.get(bindingArtifact.path);
  if (!artifactMatch) return fail('GATE_ATTACHMENT_MISSING');
  if (artifactMatch.sha256 !== context.currentArtifact.sha256 || artifactMatch.sha256 !== bindingArtifact.sha256) return fail('GATE_BINDING_HASH_MISMATCH');

  // Policy Manifest 内部 canonical checksum
  const policyBytes = readFileSync(resolve(context.repoRoot, bindingPolicy.path));
  const policyVerify = verifyPolicyManifestBytes(policyBytes);
  if (!policyVerify.ok) return fail('GATE_POLICY_MANIFEST_INVALID');
  if (policyVerify.manifest.checksum !== bindingPolicy.manifestChecksum) return fail('GATE_POLICY_MANIFEST_INVALID');
  if (bindingPolicy.manifestChecksum !== context.currentPolicyManifest.manifestChecksum) return fail('GATE_BINDING_HASH_MISMATCH');

  // artifact/commit 一致性
  if (bindingArtifact.artifactSha256 !== context.currentArtifact.artifactSha256 || bindingArtifact.commit !== context.currentArtifact.commit) {
    return fail('GATE_BINDING_HASH_MISMATCH');
  }

  // bindingSha256 重算
  const recomputed = computeBindingSha256({
    environmentSha256: bindingEnv.sha256,
    policyManifestSha256: bindingPolicy.sha256,
    policyManifestChecksum: bindingPolicy.manifestChecksum,
    artifactSha256: bindingArtifact.artifactSha256,
    commit: bindingArtifact.commit,
  });
  if (recomputed !== bindingSha256) return fail('GATE_BINDING_HASH_MISMATCH');

  // 状态分支
  if (status === 'not_applicable') {
    const unreachable = value.unreachableEvidenceIds;
    if (!isStrArrayUniqueNonEmpty(unreachable)) return fail('GATE_NA_SCOPE_MISSING');
    if (value.reasonCode !== 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE') return fail('GATE_STATUS_SHAPE_INVALID');
    if ('commands' in value) return fail('GATE_STATUS_SHAPE_INVALID');
    const unreachableAttachments = attachments.filter(a => isRecord(a) && a.kind === 'unreachable-capability');
    if (unreachableAttachments.length !== unreachable.length) return fail('GATE_NA_SCOPE_MISSING');
    return { ok: true, evidence: value as unknown as GateEvidence };
  }

  // Gate C：迁移演练必须绑定当前 registry/artifact（禁止旧 drill 或旧 descriptor 通过）
  if (context.expectedGate === 'C' && context.currentMigrationBinding) {
    const drillAttachments = attachments.filter(a => isRecord(a) && a.kind === 'migration-drill');
    if (drillAttachments.length === 0) return fail('GATE_C_CURRENT_ARTIFACT_MISMATCH');
    const drill = JSON.parse(readFileSync(resolve(context.repoRoot, drillAttachments[0]!.path), 'utf8')) as Record<string, unknown>;
    const binding = context.currentMigrationBinding;
    if (drill.registryPath !== binding.registryPath ||
        drill.descriptorId !== binding.descriptorId ||
        drill.descriptorChecksum !== binding.descriptorChecksum ||
        drill.registryArtifactSha256 !== binding.registryArtifactSha256 ||
        drill.candidateArtifactSha256 !== binding.candidateArtifactSha256 ||
        drill.policyManifestSha256 !== binding.policyManifestSha256 ||
        drill.environmentSha256 !== binding.environmentSha256 ||
        drill.compatibilityManifestSha256 !== binding.compatibilityManifestSha256) {
      return fail('GATE_C_CURRENT_ARTIFACT_MISMATCH');
    }
  }

  if (!Array.isArray(value.commands) || value.commands.length === 0) return fail('GATE_EXECUTION_SCOPE_MISSING');
  const commands: Array<Record<string, unknown>> = [];
  for (const command of value.commands) {
    if (!isRecord(command)) return fail('GATE_STATUS_SHAPE_INVALID');
    for (const key of Object.keys(command)) {
      if (!COMMAND_KEYS.includes(key)) return fail('GATE_STATUS_SHAPE_INVALID');
    }
    if (typeof command.executable !== 'string' || !Array.isArray(command.args) || !command.args.every(a => typeof a === 'string')) {
      return fail('GATE_STATUS_SHAPE_INVALID');
    }
    if (command.exitCode !== null && typeof command.exitCode !== 'number') return fail('GATE_STATUS_SHAPE_INVALID');
    const stdoutPath = command.stdoutAttachment;
    const stderrPath = command.stderrAttachment;
    if (typeof stdoutPath !== 'string' || typeof stderrPath !== 'string') return fail('GATE_COMMAND_ATTACHMENT_MISSING');
    const stdoutAtt = attachmentByPath.get(stdoutPath);
    const stderrAtt = attachmentByPath.get(stderrPath);
    if (!stdoutAtt || stdoutAtt.kind !== 'stdout') return fail('GATE_COMMAND_ATTACHMENT_MISSING');
    if (!stderrAtt || stderrAtt.kind !== 'stderr') return fail('GATE_COMMAND_ATTACHMENT_MISSING');
    commands.push(command);
  }

  if (status === 'passed') {
    if ('reasonCode' in value) return fail('GATE_STATUS_SHAPE_INVALID');
    if (commands.some(c => c.exitCode !== 0)) return fail('GATE_PASSED_COMMAND_NONZERO');
    return { ok: true, evidence: value as unknown as GateEvidence };
  }
  if (status === 'failed') {
    if (!commands.some(c => c.exitCode !== 0)) return fail('GATE_STATUS_SHAPE_INVALID');
    if (typeof value.reasonCode !== 'string' || !value.reasonCode) return fail('GATE_STATUS_SHAPE_INVALID');
    return { ok: true, evidence: value as unknown as GateEvidence };
  }
  // blocked
  if (typeof value.reasonCode !== 'string' || !value.reasonCode) return fail('GATE_STATUS_SHAPE_INVALID');
  return { ok: true, evidence: value as unknown as GateEvidence };
}

export function writeValidatedGateEvidence(
  outputPath: string,
  value: unknown,
  context: GateEvidenceContext,
): { ok: true; sha256: Sha256 } | { ok: false; code: GateEvidenceErrorCode } {
  const result = validateGateEvidence(value, context);
  if (!result.ok) return result;
  mkdirSync(dirname(outputPath), { recursive: true });
  const text = JSON.stringify(result.evidence, null, 2);
  writeFileSync(outputPath, text, 'utf8');
  return { ok: true, sha256: sha256(Buffer.from(text, 'utf8')) };
}

export { canonicalJson };
export function sha256Of(value: string): string {
  return sha256(Buffer.from(value, 'utf8'));
}
export function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256_RE.test(value);
}
export function isRelativePathInRepo(value: unknown, repoRoot: string): value is string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('..') || value.includes('\\')) return false;
  const resolvedPath = resolve(repoRoot, value);
  return resolvedPath.startsWith(resolve(repoRoot));
}
export function normalizedRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}
export function relativeToRepo(repoRoot: string, path: string): string {
  return normalizedRelativePath(relative(repoRoot, path));
}
export function sha256File(repoRoot: string, path: string): string {
  return sha256(readFileSync(resolve(repoRoot, path)));
}
export function joinRepoPath(repoRoot: string, path: string): string {
  return resolve(repoRoot, path);
}
