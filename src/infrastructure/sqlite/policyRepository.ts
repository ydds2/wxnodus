// src/infrastructure/sqlite/policyRepository.ts — SQLite policy snapshot 仓储（checksum 校验，损坏 → POLICY_UNAVAILABLE）
import type Database from 'better-sqlite3';
import type { OperationResult } from '../../protocol/results.js';
import { sha256Canonical } from '../../domain/security/approvalGrant.js';
import type { PolicyDocument, PolicySnapshot } from '../../domain/security/pdp.js';

type Row = { id: string; document_json: string; checksum: string };
const unavailable = (): OperationResult<never> => ({ ok: false, error: { code: 'POLICY_UNAVAILABLE', message: 'Policy unavailable', messageKey: 'policy.unavailable', retryable: false } });

export class SqlitePolicyRepository {
  constructor(private readonly db: Database.Database, private readonly readRaw: () => Row | undefined = () => this.db.prepare('SELECT id,document_json,checksum FROM policy_snapshots WHERE active=1').get() as Row | undefined) {}
  loadActive(): OperationResult<PolicySnapshot> {
    try {
      const row = this.readRaw(); if (!row) return unavailable();
      const document = JSON.parse(row.document_json) as PolicyDocument;
      if (document.version !== 1 || !Array.isArray(document.rules) || !Array.isArray(document.hardRedlineKinds) || sha256Canonical(document) !== row.checksum) return unavailable();
      return { ok: true, value: { id: row.id, checksum: row.checksum, document } };
    } catch { return unavailable(); }
  }
}
