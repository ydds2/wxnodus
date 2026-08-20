// src/application/tools/toolEvidenceStore.ts — W1-08：工具执行证据（sha256 绑定 + 原子写 + 读回重算）
// captureEvidence 端口：effectId → 证据 JSON（toolId/argsHash/context/journal/value 摘要）落盘
// <dataDir>/evidence/tools/<effectId>.json；篡改读回 TOOL_EVIDENCE_INTEGRITY_FAILED（绝不静默重生成）。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ToolEvidenceRecord {
  schemaVersion: 1;
  evidenceId: string;
  effectId: string;
  toolId: string;
  argsHash: string;
  context: { actorId: string; sessionId: string; runId: string | null; correlationId: string; parentCorrelationId?: string; policySnapshotId: string };
  journal: string[];
  value: unknown;
  sha256: string;
}

export interface ToolEvidenceStore {
  close(effectId: string, payload: { toolId: string; argsHash: string; context: OperationContext; journal: string[]; value: unknown }): OperationResult<{ evidenceId: string }>;
  readVerified(effectId: string): OperationResult<ToolEvidenceRecord>;
}

export function createToolEvidenceStore(dataDir: string): ToolEvidenceStore {
  const dir = join(dataDir, 'evidence', 'tools');
  mkdirSync(dir, { recursive: true });
  const fileFor = (effectId: string) => join(dir, `${effectId}.json`);
  return {
    close(effectId, payload) {
      try {
        const evidenceId = `tool-evidence-${effectId}`;
        const body = {
          schemaVersion: 1 as const,
          evidenceId,
          effectId,
          toolId: payload.toolId,
          argsHash: payload.argsHash,
          context: {
            actorId: payload.context.actorId,
            sessionId: payload.context.sessionId,
            runId: payload.context.runId,
            correlationId: payload.context.correlationId,
            ...(payload.context.parentCorrelationId ? { parentCorrelationId: payload.context.parentCorrelationId } : {}),
            policySnapshotId: payload.context.policySnapshotId,
          },
          journal: [...payload.journal],
          value: payload.value,
        };
        const record = { ...body, sha256: sha256(JSON.stringify(body)) };
        const file = fileFor(effectId);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
        renameSync(tmp, file);
        return ok({ evidenceId });
      } catch (cause) {
        return err(gatewayError('TOOL_EVIDENCE_WRITE_FAILED', String((cause as Error)?.message ?? cause).slice(0, 160), 'tool.evidence.write.failed'));
      }
    },
    readVerified(effectId) {
      try {
        const raw = readFileSync(fileFor(effectId), 'utf8');
        const record = JSON.parse(raw) as ToolEvidenceRecord;
        const { sha256: bound, ...body } = record;
        if (record.schemaVersion !== 1 || bound !== sha256(JSON.stringify(body)) || body.effectId !== effectId) {
          return err(gatewayError('TOOL_EVIDENCE_INTEGRITY_FAILED', `工具证据完整性失败：${effectId}`, 'tool.evidence.integrity'));
        }
        return ok(record);
      } catch (cause) {
        const message = String((cause as Error)?.message ?? cause).slice(0, 160);
        return err(gatewayError('TOOL_EVIDENCE_INTEGRITY_FAILED', message, 'tool.evidence.integrity'));
      }
    },
  };
}

export const toolEvidenceDir = (dataDir: string) => join(dataDir, 'evidence', 'tools');
export const evidenceFile = (dataDir: string, effectId: string) => join(toolEvidenceDir(dataDir), `${effectId}.json`);
