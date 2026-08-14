// tests/wave-p0/p0-requirement-evidence.test.ts — W0-03：evidence index 与 requirement 绑定约束
// release 模式：只有 verified requirement 且其 evidence 与当前 index/candidate 全匹配才能关闭；
// planned/implemented/skipped/blocked/not_applicable 一律不放行；当前 requirements 保持 planned，不得伪造 verified。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateEvidenceIndex } from '../../src/release/evidenceIndexSchema.js';
import { resolveRequirementEvidence } from '../../src/release/requirementEvidenceResolver.js';
import type { RequirementCoverage } from '../../src/release/requirementSchema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const candidate = {
  commit: '7'.repeat(40),
  artifactId: 'artifact-1',
  artifactSha256: 'a'.repeat(64),
};

const index = {
  schemaVersion: 1 as const,
  candidate,
  evidence: [
    {
      id: 'evidence-1',
      gate: 'A',
      platform: 'windows',
      profile: 'core',
      scenarios: ['无 TUI 启动'],
      artifactSha256: candidate.artifactSha256,
      attachments: [{ path: 'docs/superpowers/evidence/wave0/attachments/stdout-a.txt', sha256: 'b'.repeat(64) }],
    },
    {
      id: 'evidence-2',
      gate: 'B',
      platform: 'windows',
      profile: 'core',
      scenarios: ['无 TUI 启动'],
      artifactSha256: candidate.artifactSha256,
      attachments: [],
    },
  ],
};

const requirement = (overrides: Partial<RequirementCoverage> = {}): RequirementCoverage => ({
  id: 'R01',
  subprojects: ['S1'],
  artifacts: ['src/bootstrap/'],
  profiles: ['core', 'standard'],
  platforms: ['windows', 'linux'],
  positiveScenarios: ['无 TUI 启动'],
  negativeScenarios: ['UI 越层依赖应失败'],
  gates: ['A', 'B'],
  evidenceRequirements: ['boundary test'],
  evidenceIds: ['evidence-1', 'evidence-2'],
  status: 'verified',
  ...overrides,
});

describe('evidence index validation', () => {
  it('accepts a unique closed candidate-bound index', () => {
    expect(validateEvidenceIndex(index)).toMatchObject({ ok: true });
  });

  it.each([
    { name: 'duplicate evidence id', prepare: (value: unknown) => ({
      ...(value as Record<string, unknown>),
      evidence: [...index.evidence, index.evidence[0]],
    }) },
    { name: 'invalid sha256', prepare: (value: unknown) => ({
      ...(value as Record<string, unknown>),
      evidence: [{ ...index.evidence[0]!, artifactSha256: 'not-a-hash' }],
    }) },
    { name: 'attachment escaping repo root', prepare: (value: unknown) => ({
      ...(value as Record<string, unknown>),
      evidence: [{ ...index.evidence[0]!, attachments: [{ path: '../outside.txt', sha256: 'c'.repeat(64) }] }],
    }) },
    { name: 'missing candidate', prepare: () => ({ schemaVersion: 1, evidence: index.evidence }) },
  ])('rejects an index with $name', ({ prepare }) => {
    expect(validateEvidenceIndex(prepare(index))).toMatchObject({ ok: false });
  });
});

describe('requirement evidence resolution', () => {
  it('closes a release requirement only when verified and fully candidate-bound', () => {
    const result = resolveRequirementEvidence([requirement()], validateEvidenceIndex(index), candidate);
    expect(result).toMatchObject({ ok: true, perRequirement: [{ id: 'R01', status: 'verified' }] });
  });

  it.each(['planned', 'implemented', 'skipped', 'blocked', 'not_applicable'] as const)(
    'never closes a release requirement with status %s',
    status => {
      const result = resolveRequirementEvidence([requirement({ status, evidenceIds: [] })], validateEvidenceIndex(index), candidate);
      expect(result.ok).toBe(false);
      expect(result.issues.some(issue => issue.startsWith('REQUIREMENT_NOT_VERIFIED:R01'))).toBe(true);
    },
  );

  it('rejects a verified requirement whose evidence id is absent from the index', () => {
    const result = resolveRequirementEvidence(
      [requirement({ evidenceIds: ['evidence-missing'] })],
      validateEvidenceIndex(index),
      candidate,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some(issue => issue.startsWith('REQUIREMENT_EVIDENCE_MISSING:R01'))).toBe(true);
  });

  it('rejects a verified requirement whose evidence binds a different candidate', () => {
    const result = resolveRequirementEvidence(
      [requirement()],
      validateEvidenceIndex(index),
      { ...candidate, artifactSha256: 'd'.repeat(64) },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some(issue => issue.startsWith('REQUIREMENT_CANDIDATE_MISMATCH:R01'))).toBe(true);
  });

  it('rejects evidence whose gate or platform falls outside the requirement scope', () => {
    const outOfScope = {
      ...index,
      evidence: [
        { ...index.evidence[0]!, id: 'evidence-1' },
        { ...index.evidence[1]!, id: 'evidence-2', gate: 'D' },
      ],
    };
    const result = resolveRequirementEvidence([requirement()], validateEvidenceIndex(outOfScope), candidate);
    expect(result.ok).toBe(false);
    expect(result.issues.some(issue => issue.startsWith('REQUIREMENT_EVIDENCE_SCOPE_MISMATCH:R01'))).toBe(true);
  });

  it('keeps the current all-planned requirements unverifiable in release mode without forging evidence', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(repoRoot, 'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json'), 'utf8'),
    ) as RequirementCoverage[];
    const result = resolveRequirementEvidence(fixture, validateEvidenceIndex(index), candidate);
    expect(result.ok).toBe(false);
    expect(result.issues.filter(issue => issue.startsWith('REQUIREMENT_NOT_VERIFIED'))).toHaveLength(20);
  });
});
