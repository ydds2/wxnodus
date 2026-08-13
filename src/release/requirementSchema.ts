// src/release/requirementSchema.ts — R01-R20 需求覆盖检查（唯一 schema + 唯一 checker）
export interface RequirementCoverage {
  id: `R${string}`;
  subprojects: string[];
  artifacts: string[];
  profiles: Array<'core' | 'standard' | 'full-local-ai'>;
  platforms: Array<'windows' | 'linux' | 'macos'>;
  positiveScenarios: string[];
  negativeScenarios: string[];
  gates: Array<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I'>;
  evidenceRequirements: string[];
  evidenceIds: string[];
  status: 'planned' | 'implemented' | 'verified' | 'blocked';
}

const REQUIREMENTS = Array.from(
  { length: 20 },
  (_, index) => `R${String(index + 1).padStart(2, '0')}`,
);
const SUBPROJECTS = Array.from({ length: 13 }, (_, index) => `S${index + 1}`);

export interface RequirementCoverageResult {
  ok: boolean;
  issues: string[];
  requirementIds: string[];
  subprojectIds: string[];
}

export function checkRequirementCoverage(value: unknown): RequirementCoverageResult {
  const rows = Array.isArray(value) ? value as RequirementCoverage[] : [];
  const issues: string[] = [];
  const ids = rows.map(row => row.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(REQUIREMENTS)) issues.push('REQUIREMENT_ID_SET_MISMATCH');

  const referencedSubprojects = [...new Set(rows.flatMap(row => row.subprojects))].sort((a, b) =>
    Number(a.slice(1)) - Number(b.slice(1)),
  );
  for (const id of SUBPROJECTS) {
    if (!referencedSubprojects.includes(id)) issues.push(`SUBPROJECT_UNREFERENCED:${id}`);
  }

  for (const row of rows) {
    const requiredArrays: Array<[string, unknown[]]> = [
      ['artifacts', row.artifacts],
      ['profiles', row.profiles],
      ['platforms', row.platforms],
      ['positiveScenarios', row.positiveScenarios],
      ['negativeScenarios', row.negativeScenarios],
      ['gates', row.gates],
      ['evidenceRequirements', row.evidenceRequirements],
    ];
    for (const [field, entries] of requiredArrays) {
      if (!Array.isArray(entries) || entries.length === 0) issues.push(`REQUIREMENT_FIELD_EMPTY:${row.id}:${field}`);
    }
    if (row.status === 'verified' && (!Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0)) {
      issues.push(`VERIFIED_WITHOUT_EVIDENCE:${row.id}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    requirementIds: ids,
    subprojectIds: referencedSubprojects,
  };
}
