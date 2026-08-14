// tests/wave1/w1-08-pipeline-provisioning.test.ts — W1-08 RED：安全控制面置备 + UoW 生命周期扩展
// provision：幂等 / checksum 漂移轮换 / budget 轮换重置；UoW：journal 状态追加哈希链、
// commit 只落链、release 退款 + released 落链（pipeline 11 ports 的前置契约）
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical } from '../../src/domain/security/approvalGrant.js';
import type { PolicyDocument } from '../../src/domain/security/pdp.js';
import { installSecuritySchema, SqliteAuthorizationUnitOfWork } from '../../src/infrastructure/sqlite/authorizationUnitOfWork.js';
import { SqlitePolicyRepository } from '../../src/infrastructure/sqlite/policyRepository.js';
import { provisionSecurityControlPlane } from '../../src/infrastructure/sqlite/securityProvisioning.js';

const opened: Database.Database[] = [];
const policyDoc: PolicyDocument = {
  version: 1,
  hardRedlineKinds: ['process.spawn'],
  rules: [
    { effectKind: 'filesystem.write', action: 'require_approval' },
    { effectKind: 'memory.read', action: 'allow' },
  ],
};
const limits = { externalWrites: 1, processSpawns: 2 };

function fixture() {
  const db = new Database(':memory:');
  opened.push(db);
  const uow = () => new SqliteAuthorizationUnitOfWork(db, new SqlitePolicyRepository(db));
  return { db, uow };
}

afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe('W1-08 security control plane provisioning', () => {
  it('provisions idempotently and binds active snapshot ids', () => {
    const { db } = fixture();
    const first = provisionSecurityControlPlane(db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: '2026-08-13T00:00:00.000Z' });
    expect(first).toMatchObject({ ok: true, value: { policySnapshotId: 'policy-1', budgetSnapshotId: 'budget-1' } });
    const again = provisionSecurityControlPlane(db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: '2026-08-13T00:00:01.000Z' });
    expect(again.ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM policy_snapshots').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM budget_snapshots').get()).toEqual({ c: 1 });
  });

  it('rotates on policy checksum drift and budget limits change (used resets)', () => {
    const { db } = fixture();
    provisionSecurityControlPlane(db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: 't1' });
    db.prepare('UPDATE budget_snapshots SET used_json=? WHERE active=1').run(JSON.stringify({ externalWrites: 1 }));
    const rotated = provisionSecurityControlPlane(db, {
      policy: { id: 'policy-2', document: { ...policyDoc, rules: [{ effectKind: 'filesystem.write', action: 'deny' }] } },
      budget: { id: 'budget-1', limits: { ...limits, externalWrites: 5 } },
      now: 't2',
    });
    expect(rotated.ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM policy_snapshots WHERE active=1').get()).toEqual({ c: 1 });
    const active = db.prepare('SELECT id,used_json FROM budget_snapshots WHERE active=1').get() as { id: string; used_json: string };
    expect(active.used_json).toBe('{}');
  });

  it('survives a policy document whose checksum does not parse in the repository', () => {
    const { db, uow } = fixture();
    provisionSecurityControlPlane(db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: 't1' });
    const loaded = new SqlitePolicyRepository(db).loadActive();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(sha256Canonical(loaded.value.document)).toBe(loaded.value.checksum);
    expect(uow().activeBudgetSnapshotId()).toMatchObject({ ok: true, value: 'budget-1' });
  });
});

describe('W1-08 UoW lifecycle extension', () => {
  it('appends applied/committed states onto the verified hash chain', () => {
    const { db, uow } = fixture();
    provisionSecurityControlPlane(db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: 't1' });
    expect(uow().appendJournalEntry('effect-1', 'applied', { bytes: 2 }, 't2')).toMatchObject({ ok: true });
    expect(uow().commit('grant-missing', { bytes: 2 }, 't3')).toMatchObject({ ok: false, error: { code: 'APPROVAL_REPLAYED' } });
    expect(uow().appendJournalEntry('effect-1', 'committed', { bytes: 2 }, 't4')).toMatchObject({ ok: true });
    expect(uow().verifyJournal()).toMatchObject({ ok: true });
  });

  it('commit requires a consumed grant; release refunds budget and journals released', () => {
    const { db, uow } = fixture();
    provisionSecurityControlPlane(db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: 't1' });
    const unit = uow();
    const issued = unit.issue({
      id: 'grant-1',
      context: {
        actorId: 'maker', sessionId: 's1', runId: 'r1', toolId: 'builtin:fs-write' as never,
        argsHash: 'a'.repeat(64),
        effect: { kind: 'filesystem.write', resource: 'file:///w/a.txt', operation: 'replace', external: false, dataClassification: 'internal', reversibility: 'reversible' },
        resourceHash: sha256Canonical('file:///w/a.txt'),
        policySnapshotId: 'policy-1', budgetSnapshotId: 'budget-1',
      },
      nonce: 'n1', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z',
    });
    expect(issued.ok).toBe(true);
    expect(unit.consumeAndReserve({
      grantId: 'grant-1',
      context: issued.ok ? {
        actorId: issued.value.actorId, sessionId: issued.value.sessionId, runId: issued.value.runId,
        toolId: issued.value.toolId, argsHash: issued.value.argsHash, effect: { kind: 'filesystem.write', resource: 'file:///w/a.txt', operation: 'replace', external: false, dataClassification: 'internal', reversibility: 'reversible' },
        resourceHash: issued.value.resourceHash, policySnapshotId: issued.value.policySnapshotId, budgetSnapshotId: issued.value.budgetSnapshotId,
      } : ({} as never),
      reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z',
    })).toMatchObject({ ok: true });
    expect((db.prepare('SELECT used_json FROM budget_snapshots WHERE active=1').get() as { used_json: string }).used_json).toBe('{"externalWrites":1}');
    // 未消费 grant 不可 commit
    const second = fixture();
    provisionSecurityControlPlane(second.db, { policy: { id: 'policy-1', document: policyDoc }, budget: { id: 'budget-1', limits }, now: 't1' });
    expect(second.uow().commit('grant-1', {}, 't3')).toMatchObject({ ok: false, error: { code: 'APPROVAL_REPLAYED' } });
    // release 退款 + 落链（归零即清键——不留预算残渣）
    expect(unit.release('grant-1', { externalWrites: 1 }, 't4')).toMatchObject({ ok: true });
    expect((db.prepare('SELECT used_json FROM budget_snapshots WHERE active=1').get() as { used_json: string }).used_json).toBe('{}');
    expect(unit.verifyJournal()).toMatchObject({ ok: true });
  });
});
