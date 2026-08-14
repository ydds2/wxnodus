// src/infrastructure/sqlite/securityProvisioning.ts — W1-08：安全控制面置备（policy/budget 快照激活）
// 幂等：同 id 同内容不重复插入；checksum 漂移 → 轮换（旧快照 deactivate、新快照 active=1）。
// budget 轮换重置 used=0（诚实语义：预算快照换代即重计）。
import type Database from 'better-sqlite3';
import type { OperationResult } from '../../protocol/results.js';
import { sha256Canonical } from '../../domain/security/approvalGrant.js';
import type { PolicyDocument } from '../../domain/security/pdp.js';
import { installSecuritySchema } from './authorizationUnitOfWork.js';

type Budget = Record<string, number>;

export interface ProvisionInput {
  policy: { id: string; document: PolicyDocument };
  budget: { id: string; limits: Budget };
  now: string;
}

const fail = (code: string, cause?: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: cause ?? code, messageKey: code, retryable: false },
});

export function provisionSecurityControlPlane(
  db: Database.Database,
  input: ProvisionInput,
): OperationResult<{ policySnapshotId: string; budgetSnapshotId: string }> {
  try {
    return db.transaction(() => {
      installSecuritySchema(db);
      const policyJson = JSON.stringify(input.policy.document);
      const policyChecksum = sha256Canonical(input.policy.document);
      const activePolicy = db.prepare('SELECT id,checksum FROM policy_snapshots WHERE active=1').get() as { id: string; checksum: string } | undefined;
      if (!activePolicy) {
        db.prepare('INSERT INTO policy_snapshots VALUES(?,?,?,1)').run(input.policy.id, policyJson, policyChecksum);
      } else if (activePolicy.id !== input.policy.id || activePolicy.checksum !== policyChecksum) {
        db.prepare('UPDATE policy_snapshots SET active=0 WHERE active=1').run();
        db.prepare('INSERT OR REPLACE INTO policy_snapshots VALUES(?,?,?,1)').run(input.policy.id, policyJson, policyChecksum);
      }
      const limitsJson = JSON.stringify(input.budget.limits);
      const activeBudget = db.prepare('SELECT id,limits_json FROM budget_snapshots WHERE active=1').get() as { id: string; limits_json: string } | undefined;
      if (!activeBudget) {
        db.prepare('INSERT INTO budget_snapshots VALUES(?,?,?,1)').run(input.budget.id, limitsJson, JSON.stringify({}));
      } else if (activeBudget.id !== input.budget.id || activeBudget.limits_json !== limitsJson) {
        db.prepare('UPDATE budget_snapshots SET active=0 WHERE active=1').run();
        db.prepare('INSERT OR REPLACE INTO budget_snapshots VALUES(?,?,?,1)').run(input.budget.id, limitsJson, JSON.stringify({}));
      }
      return { ok: true as const, value: { policySnapshotId: input.policy.id, budgetSnapshotId: input.budget.id } };
    })();
  } catch (cause) {
    return fail('PROVISION_FAILED', String((cause as Error)?.message ?? cause).slice(0, 200));
  }
}
