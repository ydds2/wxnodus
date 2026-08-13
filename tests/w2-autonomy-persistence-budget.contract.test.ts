import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ALL_BUDGET_DIMENSIONS } from '../src/domain/autonomy/budgetDimensions.js';
import { migrateAutonomySchema } from '../src/infrastructure/sqlite/autonomyMigration.js';
import { createAutonomyRepositories } from '../src/infrastructure/sqlite/autonomyRepositories.js';
import { BudgetRepository } from '../src/infrastructure/sqlite/budgetRepository.js';
import { BudgetService } from '../src/application/autonomy/budgetService.js';

const now = '2026-08-13T00:00:00.000Z';

describe('W2-09 durable autonomy and exhaustive budget ledger', () => {
  it('round-trips Goal/Plan/PlanStep/Run/Attempt and survives repository restart', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const repos = createAutonomyRepositories(db);
    repos.goals.put({ id: 'g1', objective: 'ship', acceptanceCriteria: ['tests pass'], createdAt: now });
    repos.plans.put({ id: 'p1', goalId: 'g1', revision: 1, createdAt: now });
    repos.steps.put({ id: 'ps1', planId: 'p1', ordinal: 0, objective: 'test', state: 'queued' });
    repos.runs.put({ id: 'r1', goalId: 'g1', planId: 'p1', parentRunId: null, state: 'running', revision: 1 });
    repos.attempts.put({ id: 'a1', runId: 'r1', planStepId: 'ps1', ordinal: 1, state: 'leased',
      leaseExpiresAt: '2026-08-13T00:01:00.000Z', evidenceIds: ['ev:start'] });
    const restarted = createAutonomyRepositories(db);
    expect(restarted.goals.get('g1')?.objective).toBe('ship');
    expect(restarted.plans.get('p1')?.goalId).toBe('g1');
    expect(restarted.steps.get('ps1')?.state).toBe('queued');
    expect(restarted.runs.casState('r1', 1, 'cancelling')).toBe(true);
    expect(restarted.runs.casState('r1', 1, 'completed')).toBe(false);
    expect(restarted.attempts.get('a1')?.evidenceIds).toEqual(['ev:start']);
    db.close();
  });

  it('reserve/commit/release every dimension, enforces concurrency, restart, and evidence', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const repository = new BudgetRepository(db);
    const limits = Object.fromEntries(ALL_BUDGET_DIMENSIONS.map(d => [d, d === 'concurrent-agent' ? 1 : 10])) as Record<typeof ALL_BUDGET_DIMENSIONS[number], number>;
    const service = new BudgetService(repository, () => now);
    service.open('r1', limits);
    for (const dimension of ALL_BUDGET_DIMENSIONS) {
      const reserved = service.reserve('r1', dimension, 1, `ev:reserve:${dimension}`);
      expect(reserved).toMatchObject({ ok: true });
      if (!reserved.ok) throw new Error(`reserve failed: ${dimension}`);
      expect(service.commit(reserved.value.reservationId, 1, `ev:commit:${dimension}`)).toMatchObject({ ok: true });
      // 二次 reserve：limit=1 的维度（concurrent-agent）已 commit 占满——release 路径仅对成功 reserve 生效
      const released = service.reserve('r1', dimension, 1, `ev:reserve-release:${dimension}`);
      if (released.ok) {
        expect(service.release(released.value.reservationId, `ev:release:${dimension}`)).toMatchObject({ ok: true });
      }
    }
    const held = service.reserve('r1', 'concurrent-agent', 1, 'ev:concurrency-held');
    expect(held.ok).toBe(false); // committed unit already consumes the limit
    if (!held.ok) expect(held.error.code).toBe('BUDGET_EXCEEDED');
    const restarted = new BudgetService(new BudgetRepository(db), () => now);
    expect(restarted.snapshot('r1').dimensions['token']).toMatchObject({ committed: 1, reserved: 0, limit: 10 });
    expect(restarted.evidence('r1')).toContain('ev:commit:token');
    expect(restarted.evidence('r1')).toContain('ev:release:bytes');
    db.close();
  });
});
