// src/release/evidenceIndexImporter.ts — W6-01：run 目录 → evidence index 导入（唯一证据索引生产者）
// 只收 passed 门证据；attachments 逐文件真实 sha256 绑定；路径 repo 相对（相对 repoRoot）；runId/suite/
// importProvenance 全绑定；candidate 三元组（runId/commit/artifactId/artifactSha256）锁死——历史候选不得借用。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { OperationResult } from '../protocol/results.js';
import { configError } from '../domain/config/configSchema.js';
import { validateEvidenceIndex, type EvidenceIndex, type EvidenceIndexEntry } from './evidenceIndexSchema.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

export interface ImportRunEvidenceOptions {
  evidenceRoot: string;
  repoRoot: string;
  runId: string;
  candidate: { commit: string; artifactId: string; artifactSha256: string };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const fail = (code: string, messageKey: string, details?: Record<string, unknown>): OperationResult<never> =>
  ({ ok: false, error: configError(code, messageKey, details) });

/** 绝对文件 → repo 相对路径（越界即失败——绝不把 repo 外路径写进索引） */
function toRepoRelative(repoRoot: string, file: string): string | null {
  const rel = relative(repoRoot, file).replace(/\\/g, '/');
  if (rel.includes('..') || rel.startsWith('/')) return null;
  return rel;
}

const hashAttachment = (repoRoot: string, file: string): { path: string; sha256: string } | null => {
  if (!existsSync(file)) return null;
  const rel = toRepoRelative(repoRoot, file);
  if (!rel) return null;
  return { path: rel, sha256: sha256(readFileSync(file)) };
};

export function importRunEvidence(options: ImportRunEvidenceOptions): OperationResult<{ index: EvidenceIndex }> {
  const { evidenceRoot, repoRoot, runId } = options;
  if (!COMMIT_RE.test(options.candidate.commit) || !SHA256_RE.test(options.candidate.artifactSha256) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.candidate.artifactId)) {
    return fail('IMPORT_CANDIDATE_INVALID', 'evidence.import.candidate.invalid');
  }
  const runDir = join(evidenceRoot, runId);
  const entries: EvidenceIndexEntry[] = [];
  const importedAt = new Date().toISOString();

  // 1) wave3 gate-report：只收 status===0（passed）的门
  const gateReportPath = join(runDir, 'gate-report.json');
  if (!existsSync(gateReportPath)) return fail('IMPORT_GATE_REPORT_MISSING', 'evidence.import.gateReport.missing', { runId });
  let gateReport: { gates?: Record<string, number> };
  try {
    gateReport = JSON.parse(readFileSync(gateReportPath, 'utf8')) as { gates?: Record<string, number> };
  } catch {
    return fail('IMPORT_GATE_REPORT_INVALID', 'evidence.import.gateReport.invalid', { runId });
  }
  if (!gateReport.gates || typeof gateReport.gates !== 'object') {
    return fail('IMPORT_GATE_REPORT_INVALID', 'evidence.import.gateReport.invalid', { runId });
  }
  const reportAttachment = hashAttachment(repoRoot, gateReportPath);
  if (!reportAttachment) return fail('IMPORT_ATTACHMENT_OUT_OF_REPO', 'evidence.import.attachment.outOfRepo', { runId });
  for (const [gateId, status] of Object.entries(gateReport.gates)) {
    if (status !== 0) continue; // 非 passed 不入索引（事实报告保留在 gate-report 中）
    const gate = gateId.replace(/-W\d$/, '');
    if (!/^[A-I]$/.test(gate)) continue;
    entries.push({
      id: `gate-${gate}-${runId}`,
      gate, platform: 'windows', profile: 'core', scenarios: ['gate-run'],
      suite: 'wave3-gates',
      importProvenance: { source: reportAttachment.path, importedAt },
      artifactSha256: options.candidate.artifactSha256,
      attachments: [reportAttachment],
    });
  }

  // 2) Gate E aggregate（若 passed）：物理验收证据条目
  const aggregatePath = join(runDir, 'gate-e-aggregate.json');
  if (existsSync(aggregatePath)) {
    let aggregate: { status?: string };
    try { aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { status?: string }; } catch { aggregate = {}; }
    if (aggregate.status === 'passed') {
      const aggregateAttachment = hashAttachment(repoRoot, aggregatePath);
      if (!aggregateAttachment) return fail('IMPORT_ATTACHMENT_OUT_OF_REPO', 'evidence.import.attachment.outOfRepo', { runId });
      entries.push({
        id: `gate-E-${runId}`,
        gate: 'E', platform: 'windows', profile: 'core',
        scenarios: ['preflight', 'voice', 'computer-multimonitor', 'browser', 'build-restart-readback', 'uia', 'emergency-stop'],
        suite: 'windows-acceptance',
        importProvenance: { source: aggregateAttachment.path, importedAt },
        artifactSha256: options.candidate.artifactSha256,
        attachments: [aggregateAttachment],
      });
    }
  }

  const index: EvidenceIndex = {
    schemaVersion: 1,
    candidate: { runId, ...options.candidate },
    evidence: entries,
  };
  const validated = validateEvidenceIndex(index);
  if (!validated.ok) return fail('IMPORT_INDEX_INVALID', 'evidence.import.index.invalid', { issues: validated.issues });
  return { ok: true, value: { index: validated.index } };
}
