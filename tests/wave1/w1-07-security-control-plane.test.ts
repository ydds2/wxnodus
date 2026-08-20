import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { EffectDescriptor } from '../../src/domain/effects/effectDescriptor.js';
import type { ToolId } from '../../src/domain/tools/toolIds.js';
import { authorizationContextHash, sha256Canonical, type AuthorizationContext } from '../../src/domain/security/approvalGrant.js';
import { SqlitePolicyRepository } from '../../src/infrastructure/sqlite/policyRepository.js';
import { installSecuritySchema, SqliteAuthorizationUnitOfWork } from '../../src/infrastructure/sqlite/authorizationUnitOfWork.js';

const opened: Database.Database[] = [];
const effect: EffectDescriptor = {
  kind: 'filesystem.write', resource: 'file:///workspace/result.txt', operation: 'replace',
  external: false, dataClassification: 'internal', reversibility: 'reversible',
};
const context = (patch: Partial<AuthorizationContext> = {}): AuthorizationContext => ({
  invocationId: 'invocation-1',
  actorId: 'maker-1', sessionId: 'session-1', runId: 'run-1',
  toolId: 'builtin:fs-write' as ToolId,
  argsHash: sha256Canonical({ path: 'result.txt', content: 'safe' }),
  effect, resourceHash: sha256Canonical(effect.resource),
  policySnapshotId: 'policy-1', budgetSnapshotId: 'budget-1', ...patch,
});
function fixture(policyJson = JSON.stringify({
  version: 1, hardRedlineKinds: ['process.spawn'],
  rules: [{ effectKind: 'filesystem.write', action: 'require_approval' }],
}), checksum?: string) {
  const db = new Database(':memory:'); opened.push(db); installSecuritySchema(db);
  db.prepare('INSERT INTO policy_snapshots VALUES(?,?,?,1)')
    .run('policy-1', policyJson, checksum ?? sha256Canonical(JSON.parse(policyJson)));
  db.prepare('INSERT INTO budget_snapshots VALUES(?,?,?,1)')
    .run('budget-1', JSON.stringify({ externalWrites: 1 }), JSON.stringify({ externalWrites: 0 }));
  const policy = new SqlitePolicyRepository(db);
  return { db, policy, uow: new SqliteAuthorizationUnitOfWork(db, policy) };
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe('W1-07 canonical authorization', () => {
  it('binds budget snapshot and the full canonical context, then consumes once', () => {
    const { uow } = fixture();
    const issued = uow.issue({ id: 'grant-1', context: context(), nonce: 'nonce-1', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' });
    expect(issued).toMatchObject({ ok: true, value: { budgetSnapshotId: 'budget-1', authorizationContextHash: authorizationContextHash(context()) } });
    expect(uow.consumeAndReserve({ grantId: 'grant-1', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' })).toMatchObject({ ok: true });
    expect(uow.consumeAndReserve({ grantId: 'grant-1', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:02.000Z' })).toMatchObject({ ok: false, error: { code: 'APPROVAL_REPLAYED' } });
  });

  it.each([
    { invocationId: 'invocation-2' },
    { actorId: 'maker-2' }, { sessionId: 'session-2' }, { runId: 'run-2' },
    { toolId: 'builtin:bash' as ToolId }, { argsHash: 'a'.repeat(64) },
    { effect: { ...effect, operation: 'append' } }, { resourceHash: 'b'.repeat(64) },
    { policySnapshotId: 'policy-2' }, { budgetSnapshotId: 'budget-2' },
  ] as Array<Partial<AuthorizationContext>>)('rejects context drift atomically: %j', patch => {
    const { db, uow } = fixture();
    expect(uow.issue({ id: 'grant-drift', context: context(), nonce: 'nonce-drift', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    expect(uow.consumeAndReserve({ grantId: 'grant-drift', context: context(patch), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' })).toMatchObject({ ok: false, error: { code: 'APPROVAL_CONTEXT_MISMATCH' } });
    expect(db.prepare('SELECT status FROM approval_grants WHERE id=?').get('grant-drift')).toEqual({ status: 'issued' });
    expect(db.prepare('SELECT count(*) count FROM effect_journal').get()).toEqual({ count: 0 });
    expect(JSON.parse((db.prepare('SELECT used_json FROM budget_snapshots WHERE id=?').get('budget-1') as { used_json: string }).used_json)).toEqual({ externalWrites: 0 });
  });

  it.each([
    ['corrupt', '{"version":', sha256Canonical({ version: 1 })],
    ['truncated', '{"version":1,"rules":[', sha256Canonical({ version: 1 })],
    ['checksum drift', JSON.stringify({ version: 1, hardRedlineKinds: [], rules: [] }), '0'.repeat(64)],
  ])('maps %s policy to POLICY_UNAVAILABLE and creates no side effect', (_name, json, checksum) => {
    const { db, uow } = fixture(json, checksum);
    expect(uow.issue({ id: 'grant-bad', context: context(), nonce: 'nonce-bad', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'POLICY_UNAVAILABLE' } });
    expect(db.prepare('SELECT count(*) count FROM approval_grants').get()).toEqual({ count: 0 });
  });

  it('maps permission denied to POLICY_UNAVAILABLE', () => {
    const { db } = fixture();
    const denied = new SqlitePolicyRepository(db, () => { throw Object.assign(new Error('denied'), { code: 'SQLITE_AUTH' }); });
    const uow = new SqliteAuthorizationUnitOfWork(db, denied);
    expect(uow.issue({ id: 'grant-denied', context: context(), nonce: 'nonce-denied', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'POLICY_UNAVAILABLE' } });
  });

  it('enforces hard redlines, expiry, revocation, and budget limits with no partial writes', () => {
    const hard = fixture();
    const processEffect: EffectDescriptor = { ...effect, kind: 'process.spawn', resource: 'process://cmd.exe' };
    expect(hard.uow.issue({ id: 'grant-hard', context: context({ effect: processEffect }), nonce: 'nonce-hard', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(hard.uow.issue({ id: 'grant-expired', context: context(), nonce: 'nonce-expired', expiresAt: '2026-08-12T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });

    const revoked = fixture();
    expect(revoked.uow.issue({ id: 'grant-revoked', context: context(), nonce: 'nonce-revoked', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    revoked.db.prepare("UPDATE approval_grants SET status='revoked' WHERE id=?").run('grant-revoked');
    expect(revoked.uow.consumeAndReserve({ grantId: 'grant-revoked', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'APPROVAL_REVOKED' } });

    const budget = fixture();
    expect(budget.uow.issue({ id: 'grant-budget', context: context(), nonce: 'nonce-budget', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    expect(budget.uow.consumeAndReserve({ grantId: 'grant-budget', context: context(), reservation: { externalWrites: 2 }, now: '2026-08-13T00:00:01.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(budget.db.prepare('SELECT status FROM approval_grants WHERE id=?').get('grant-budget')).toEqual({ status: 'issued' });
    expect(budget.db.prepare('SELECT count(*) count FROM effect_journal').get()).toEqual({ count: 0 });
  });

  it('rechecks policy and budget in the consume transaction and verifies the journal chain', () => {
    const { db, uow } = fixture();
    expect(uow.issue({ id: 'grant-policy', context: context(), nonce: 'nonce-policy', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    db.prepare('UPDATE policy_snapshots SET active=0').run();
    const replacement = { version: 1, hardRedlineKinds: [], rules: [{ effectKind: 'filesystem.write', action: 'deny' }] };
    db.prepare('INSERT INTO policy_snapshots VALUES(?,?,?,1)').run('policy-2', JSON.stringify(replacement), sha256Canonical(replacement));
    expect(uow.consumeAndReserve({ grantId: 'grant-policy', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' })).toMatchObject({ ok: false, error: { code: 'POLICY_CHANGED' } });
    expect(db.prepare('SELECT status FROM approval_grants WHERE id=?').get('grant-policy')).toEqual({ status: 'issued' });

    const fresh = fixture();
    expect(fresh.uow.issue({ id: 'grant-chain', context: context(), nonce: 'nonce-chain', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    expect(fresh.uow.consumeAndReserve({ grantId: 'grant-chain', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' }).ok).toBe(true);
    expect(fresh.uow.verifyJournal()).toEqual({ ok: true, value: undefined });
    fresh.db.prepare("UPDATE effect_journal SET payload_json='{}' WHERE sequence=1").run();
    expect(fresh.uow.verifyJournal()).toMatchObject({ ok: false, error: { code: 'EFFECT_JOURNAL_INTEGRITY_FAILED' } });
  });
});
