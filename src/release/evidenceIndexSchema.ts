// src/release/evidenceIndexSchema.ts — W0-03：版本化 evidence index（release 唯一证据索引）
// 只接受 candidate 绑定的唯一闭合索引；id/hash/path 严格校验，绝不借用历史 candidate 的证据。
// W6-01：candidate 绑定 runId；entry 绑定 suite + importProvenance（来源文件 repo 相对路径 + 导入时间）。
export interface EvidenceIndexAttachment {
  path: string;
  sha256: string;
}

export interface EvidenceIndexEntry {
  id: string;
  gate: string;
  platform: string;
  profile: string;
  scenarios: string[];
  suite: string;
  importProvenance: { source: string; importedAt: string };
  artifactSha256: string;
  attachments: EvidenceIndexAttachment[];
}

export interface EvidenceIndexCandidate {
  runId: string;
  commit: string;
  artifactId: string;
  artifactSha256: string;
}

export interface EvidenceIndex {
  schemaVersion: 1;
  candidate: EvidenceIndexCandidate;
  evidence: EvidenceIndexEntry[];
}

export interface EvidenceIndexValidationResult {
  ok: boolean;
  issues: string[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** repo 相对路径（无 ..、无反斜杠、不以 / 开头）——附件与 provenance source 共用 */
export const isRepoRelativePath = (path: string): boolean =>
  path.length > 0 && !path.includes('..') && !path.includes('\\') && !path.startsWith('/');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEvidenceIndex(value: unknown): {
  ok: true;
  index: EvidenceIndex;
} | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(value) || value.schemaVersion !== 1) {
    issues.push('EVIDENCE_INDEX_SCHEMA_INVALID');
    return { ok: false, issues };
  }
  const candidate = value.candidate;
  if (!isRecord(candidate) || typeof candidate.runId !== 'string' || !SAFE_ID_RE.test(candidate.runId) ||
      typeof candidate.commit !== 'string' || !COMMIT_RE.test(candidate.commit) ||
      typeof candidate.artifactId !== 'string' || !SAFE_ID_RE.test(candidate.artifactId) ||
      typeof candidate.artifactSha256 !== 'string' || !SHA256_RE.test(candidate.artifactSha256)) {
    issues.push('EVIDENCE_INDEX_CANDIDATE_INVALID');
  }
  const rows = Array.isArray(value.evidence) ? value.evidence : [];
  const seenIds = new Set<string>();
  rows.forEach((raw, position) => {
    if (!isRecord(raw)) {
      issues.push(`EVIDENCE_INDEX_ENTRY_INVALID:${position}`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!SAFE_ID_RE.test(id)) {
      issues.push(`EVIDENCE_INDEX_ENTRY_INVALID:${position}`);
      return;
    }
    if (seenIds.has(id)) issues.push(`EVIDENCE_INDEX_DUPLICATE_ID:${id}`);
    seenIds.add(id);
    if (typeof entry.gate !== 'string' || !/^[A-I]$/.test(entry.gate)) issues.push(`EVIDENCE_INDEX_GATE_INVALID:${id}`);
    if (typeof entry.platform !== 'string' || !['windows', 'linux', 'macos'].includes(entry.platform)) issues.push(`EVIDENCE_INDEX_PLATFORM_INVALID:${id}`);
    if (typeof entry.profile !== 'string' || !['core', 'standard', 'full-local-ai'].includes(entry.profile)) issues.push(`EVIDENCE_INDEX_PROFILE_INVALID:${id}`);
    if (!Array.isArray(entry.scenarios) || entry.scenarios.length === 0 || entry.scenarios.some(s => typeof s !== 'string' || s.trim().length === 0)) {
      issues.push(`EVIDENCE_INDEX_SCENARIOS_INVALID:${id}`);
    }
    if (typeof entry.suite !== 'string' || entry.suite.trim().length === 0) issues.push(`EVIDENCE_INDEX_SUITE_INVALID:${id}`);
    if (!isRecord(entry.importProvenance) ||
        typeof (entry.importProvenance as Record<string, unknown>).source !== 'string' ||
        !isRepoRelativePath((entry.importProvenance as Record<string, unknown>).source as string) ||
        typeof (entry.importProvenance as Record<string, unknown>).importedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test((entry.importProvenance as Record<string, unknown>).importedAt as string)) {
      issues.push(`EVIDENCE_INDEX_PROVENANCE_INVALID:${id}`);
    }
    if (typeof entry.artifactSha256 !== 'string' || !SHA256_RE.test(entry.artifactSha256)) issues.push(`EVIDENCE_INDEX_ARTIFACT_INVALID:${id}`);
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : null;
    if (attachments === null) {
      issues.push(`EVIDENCE_INDEX_ATTACHMENTS_INVALID:${id}`);
      return;
    }
    // 附件路径去重限条目内（多条目共享同一来源文件——如 gate-report——是合法导入形态）
    const seenPaths = new Set<string>();
    for (const rawAttachment of attachments) {
      if (!isRecord(rawAttachment) || typeof rawAttachment.path !== 'string' || !isRepoRelativePath(rawAttachment.path) ||
          typeof rawAttachment.sha256 !== 'string' || !SHA256_RE.test(rawAttachment.sha256)) {
        issues.push(`EVIDENCE_INDEX_ATTACHMENT_INVALID:${id}`);
        continue;
      }
      if (seenPaths.has(rawAttachment.path)) issues.push(`EVIDENCE_INDEX_ATTACHMENT_DUPLICATE:${id}`);
      seenPaths.add(rawAttachment.path);
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, index: value as unknown as EvidenceIndex };
}
