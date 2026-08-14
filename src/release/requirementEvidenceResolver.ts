// src/release/requirementEvidenceResolver.ts — W0-03：release 模式 requirement → evidence 解析
// 只有 verified requirement 且其每条 evidence 存在于当前 index 并完全绑定 candidate/gate/platform/profile/scenario 才能关闭；
// planned/implemented/skipped/blocked/not_applicable 一律不放行，缺失/越界/漂移稳定失败，绝不伪造 verified。
import type { EvidenceIndex, EvidenceIndexCandidate, EvidenceIndexEntry } from './evidenceIndexSchema.js';
import type { RequirementCoverage } from './requirementSchema.js';

export interface ResolvedRequirement {
  id: string;
  status: RequirementCoverage['status'];
  issues: string[];
}

export interface RequirementEvidenceResult {
  ok: boolean;
  issues: string[];
  perRequirement: ResolvedRequirement[];
}

const CLOSING_STATUSES = new Set(['planned', 'implemented', 'verified', 'blocked', 'skipped', 'not_applicable']);

function sameCandidate(left: EvidenceIndexCandidate, right: EvidenceIndexCandidate): boolean {
  return left.commit === right.commit && left.artifactId === right.artifactId && left.artifactSha256 === right.artifactSha256;
}

function evidenceMatchesRequirement(entry: EvidenceIndexEntry, requirement: RequirementCoverage): boolean {
  return requirement.gates.includes(entry.gate as RequirementCoverage['gates'][number]) &&
    requirement.platforms.includes(entry.platform as RequirementCoverage['platforms'][number]) &&
    requirement.profiles.includes(entry.profile as RequirementCoverage['profiles'][number]) &&
    entry.scenarios.every(scenario =>
      requirement.positiveScenarios.includes(scenario) || requirement.negativeScenarios.includes(scenario));
}

export function resolveRequirementEvidence(
  requirements: readonly RequirementCoverage[],
  index: { ok: true; index: EvidenceIndex } | { ok: false; issues: string[] },
  candidate: EvidenceIndexCandidate,
): RequirementEvidenceResult {
  const issues: string[] = [];
  const perRequirement: ResolvedRequirement[] = [];
  if (!index.ok) {
    return { ok: false, issues: [...index.issues], perRequirement };
  }
  const byId = new Map(index.index.evidence.map(entry => [entry.id, entry]));
  if (!sameCandidate(index.index.candidate, candidate)) {
    issues.push(`REQUIREMENT_CANDIDATE_MISMATCH:index`);
  }

  for (const requirement of requirements) {
    const rowIssues: string[] = [];
    if (!CLOSING_STATUSES.has(requirement.status)) {
      rowIssues.push(`REQUIREMENT_STATUS_INVALID:${requirement.id}`);
    } else if (requirement.status !== 'verified') {
      rowIssues.push(`REQUIREMENT_NOT_VERIFIED:${requirement.id}`);
    } else {
      if (requirement.evidenceIds.length === 0) {
        rowIssues.push(`REQUIREMENT_EVIDENCE_MISSING:${requirement.id}`);
      }
      for (const evidenceId of requirement.evidenceIds) {
        const entry = byId.get(evidenceId);
        if (!entry) {
          rowIssues.push(`REQUIREMENT_EVIDENCE_MISSING:${requirement.id}:${evidenceId}`);
          continue;
        }
        if (entry.artifactSha256 !== candidate.artifactSha256) {
          rowIssues.push(`REQUIREMENT_CANDIDATE_MISMATCH:${requirement.id}:${evidenceId}`);
        }
        if (!evidenceMatchesRequirement(entry, requirement)) {
          rowIssues.push(`REQUIREMENT_EVIDENCE_SCOPE_MISMATCH:${requirement.id}:${evidenceId}`);
        }
      }
    }
    issues.push(...rowIssues);
    perRequirement.push({ id: requirement.id, status: requirement.status, issues: rowIssues });
  }
  return { ok: issues.length === 0, issues, perRequirement };
}
