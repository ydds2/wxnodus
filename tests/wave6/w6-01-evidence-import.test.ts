// tests/wave6/w6-01-evidence-import.test.ts — W6-01 契约：evidence 索引导入/解析接线（RED → 实现后全绿）
// importer 从 run 目录只收 passed 证据（attachments 真实 sha256 绑定 + repo 相对路径 + runId/suite/provenance）；
// 候选不一致（历史借用）→ REQUIREMENT_CANDIDATE_MISMATCH；不完整证据绝不把需求标 verified。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importRunEvidence } from '../../src/release/evidenceIndexImporter.js';
import { validateEvidenceIndex, type EvidenceIndex } from '../../src/release/evidenceIndexSchema.js';
import { resolveRequirementEvidence } from '../../src/release/requirementEvidenceResolver.js';
import type { RequirementCoverage } from '../../src/release/requirementSchema.js';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const COMMIT = 'a'.repeat(40);
const ARTIFACT_SHA = 'b'.repeat(64);

function makeRunEnv(): { repoRoot: string; evidenceRoot: string; runId: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'w6-ev-repo-'));
  const evidenceRoot = join(repoRoot, 'artifacts', 'release-evidence');
  const runId = 'run-w6-01';
  mkdirSync(join(evidenceRoot, runId), { recursive: true });
  cleanup.push(() => rmSync(repoRoot, { recursive: true, force: true }));
  return { repoRoot, evidenceRoot, runId };
}

const writeGateReport = (evidenceRoot: string, runId: string, gates: Record<string, number>): void => {
  writeFileSync(join(evidenceRoot, runId, 'gate-report.json'), JSON.stringify({ runId, wave: 3, gates, firstFailure: null }, null, 2), 'utf8');
};

describe('W6-01 evidence 索引导入（importRunEvidence）', () => {
  it('只收 passed 门证据；runId/suite/importProvenance 绑定；附件 sha256 与磁盘一致；校验通过', async () => {
    const { repoRoot, evidenceRoot, runId } = makeRunEnv();
    writeGateReport(evidenceRoot, runId, { 'A-W3': 0, 'B-W3': 2, 'C-W3': 0 });
    const result = await importRunEvidence({
      evidenceRoot, repoRoot, runId,
      candidate: { commit: COMMIT, artifactId: 'wxnodus-art', artifactSha256: ARTIFACT_SHA },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const index: EvidenceIndex = result.value.index;
    expect(index.candidate).toEqual({ runId, commit: COMMIT, artifactId: 'wxnodus-art', artifactSha256: ARTIFACT_SHA });
    const gates = index.evidence.map(entry => entry.gate).sort();
    expect(gates).toEqual(['A', 'C']); // B-W3 失败不导入
    for (const entry of index.evidence) {
      expect(entry.suite).toBe('wave3-gates');
      expect(entry.importProvenance.source).toBe(`artifacts/release-evidence/${runId}/gate-report.json`);
      expect(entry.importProvenance.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.artifactSha256).toBe(ARTIFACT_SHA);
      for (const attachment of entry.attachments) {
        const onDisk = readFileSync(join(repoRoot, attachment.path));
        expect(sha256(onDisk)).toBe(attachment.sha256);
      }
    }
    expect(validateEvidenceIndex(index)).toMatchObject({ ok: true });
  });

  it('candidate 缺 runId / 非 40-hex commit → EVIDENCE_INDEX_CANDIDATE_INVALID', () => {
    const base = {
      schemaVersion: 1,
      candidate: { commit: 'zzz', artifactId: 'x', artifactSha256: ARTIFACT_SHA },
      evidence: [],
    };
    expect(validateEvidenceIndex(base)).toMatchObject({ ok: false, issues: expect.arrayContaining(['EVIDENCE_INDEX_CANDIDATE_INVALID']) });
  });

  it('历史候选借用阻断：索引与当前候选不一致 → REQUIREMENT_CANDIDATE_MISMATCH:index（绝不借用历史证据）', async () => {
    const { repoRoot, evidenceRoot, runId } = makeRunEnv();
    writeGateReport(evidenceRoot, runId, { 'A-W3': 0 });
    const imported = await importRunEvidence({
      evidenceRoot, repoRoot, runId,
      candidate: { commit: COMMIT, artifactId: 'wxnodus-art', artifactSha256: ARTIFACT_SHA },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const requirements: RequirementCoverage[] = [{ id: 'R01', subprojects: ['S1'], artifacts: ['a'], profiles: ['core'], platforms: ['windows'], positiveScenarios: ['gate-run'], negativeScenarios: [], gates: ['A'], evidenceRequirements: ['x'], evidenceIds: [`gate-A-${runId}`], status: 'verified' }];
    // 当前候选（不同 artifactSha256）——历史索引证据不得关闭需求
    const resolved = resolveRequirementEvidence(requirements, validateEvidenceIndex(imported.value.index), { runId, commit: COMMIT, artifactId: 'wxnodus-art', artifactSha256: 'c'.repeat(64) });
    expect(resolved.ok).toBe(false);
    expect(resolved.issues).toContain('REQUIREMENT_CANDIDATE_MISMATCH:index');
    expect(resolved.issues.some(issue => issue.includes('REQUIREMENT_CANDIDATE_MISMATCH:R01'))).toBe(true);
  });

  it('附件路径逃逸（../、反斜杠、绝对路径）→ EVIDENCE_INDEX_ATTACHMENT_INVALID', () => {
    const bad = {
      schemaVersion: 1,
      candidate: { runId: 'run-1', commit: COMMIT, artifactId: 'x', artifactSha256: ARTIFACT_SHA },
      evidence: [{
        id: 'gate-A', gate: 'A', platform: 'windows', profile: 'core', scenarios: ['gate-run'],
        suite: 'wave3-gates', importProvenance: { source: 'a.json', importedAt: '2026-08-15T00:00:00.000Z' },
        artifactSha256: ARTIFACT_SHA, attachments: [{ path: '../escape.txt', sha256: 'd'.repeat(64) }],
      }],
    };
    expect(validateEvidenceIndex(bad)).toMatchObject({ ok: false, issues: expect.arrayContaining(['EVIDENCE_INDEX_ATTACHMENT_INVALID:gate-A']) });
  });

  it('不完整证据绝不伪 verified：planned 需求 + 门证据 → 逐条 REQUIREMENT_NOT_VERIFIED', async () => {
    const { repoRoot, evidenceRoot, runId } = makeRunEnv();
    writeGateReport(evidenceRoot, runId, { 'A-W3': 0 });
    const imported = await importRunEvidence({
      evidenceRoot, repoRoot, runId,
      candidate: { commit: COMMIT, artifactId: 'wxnodus-art', artifactSha256: ARTIFACT_SHA },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const requirements: RequirementCoverage[] = Array.from({ length: 20 }, (_, i) => ({
      id: `R${String(i + 1).padStart(2, '0')}`, subprojects: ['S1'], artifacts: ['a'], profiles: ['core'],
      platforms: ['windows'], positiveScenarios: ['gate-run'], negativeScenarios: [], gates: ['A'],
      evidenceRequirements: ['x'], evidenceIds: [], status: 'planned',
    }));
    const resolved = resolveRequirementEvidence(requirements, validateEvidenceIndex(imported.value.index), { runId, commit: COMMIT, artifactId: 'wxnodus-art', artifactSha256: ARTIFACT_SHA });
    expect(resolved.ok).toBe(false);
    expect(resolved.issues.filter(issue => issue.startsWith('REQUIREMENT_NOT_VERIFIED:'))).toHaveLength(20);
  });
});
