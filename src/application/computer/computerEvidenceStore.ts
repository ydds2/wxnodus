// src/application/computer/computerEvidenceStore.ts — 电脑动作证据落盘（真实可审计：JSON + sha256 绑定 + 原子写 + 读回重算）
// 注意：这是 computer action 的审计证据（不冒充 CompletionGate 的 EvidenceRecord 链——后者走 FileEvidenceStore）。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface ComputerEvidenceFile {
  schemaVersion: 1;
  evidenceId: string;
  createdAt: string;
  bundle: unknown;
  sha256: string;
}

export interface ComputerEvidenceStore {
  closeComputerAction(bundle: unknown): Promise<OperationResult<{ evidenceId: string }>>;
  readEvidence(evidenceId: string): OperationResult<ComputerEvidenceFile>;
}

export function createComputerEvidenceStore(dataDir: string, now: () => string = () => new Date().toISOString()): ComputerEvidenceStore {
  const dir = join(dataDir, 'evidence', 'computer');

  const closeComputerAction = async (bundle: unknown): Promise<OperationResult<{ evidenceId: string }>> => {
    try {
      const evidenceId = `computer-${now().replace(/[^0-9]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
      const body = { schemaVersion: 1 as const, evidenceId, createdAt: now(), bundle };
      const file: ComputerEvidenceFile = { ...body, sha256: sha256(JSON.stringify(body)) };
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${evidenceId}.json`);
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(file, null, 2), 'utf8');
      renameSync(temp, path);
      return { ok: true, value: { evidenceId } };
    } catch (cause) {
      return fail('COMPUTER_EVIDENCE_WRITE_FAILED', { cause: String(cause) });
    }
  };

  const readEvidence = (evidenceId: string): OperationResult<ComputerEvidenceFile> => {
    try {
      if (!/^[A-Za-z0-9-]+$/.test(evidenceId)) return fail('COMPUTER_EVIDENCE_ID_INVALID');
      const parsed = JSON.parse(readFileSync(join(dir, `${evidenceId}.json`), 'utf8')) as ComputerEvidenceFile;
      const recomputed = sha256(JSON.stringify({ schemaVersion: parsed.schemaVersion, evidenceId: parsed.evidenceId, createdAt: parsed.createdAt, bundle: parsed.bundle }));
      if (parsed.schemaVersion !== 1 || recomputed !== parsed.sha256) return fail('COMPUTER_EVIDENCE_INTEGRITY_FAILED');
      return { ok: true, value: parsed };
    } catch {
      return fail('COMPUTER_EVIDENCE_READ_FAILED');
    }
  };

  return { closeComputerAction, readEvidence };
}
