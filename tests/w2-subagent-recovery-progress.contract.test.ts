import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ProgressDetector } from '../src/application/autonomy/progressDetector.js';
import { migrateAutonomySchema } from '../src/infrastructure/sqlite/autonomyMigration.js';
import { ProgressStateRepository } from '../src/infrastructure/sqlite/progressStateRepository.js';
import type { ProgressObservation, ProgressStopReason } from '../src/domain/autonomy/progressReasons.js';

const neutral = (patch: Partial<ProgressObservation> = {}): ProgressObservation => ({ stateChanged: true,
  actionKey: 'next', errorCode: null, evidenceDelta: 1, planRevision: 1, planDirection: 'forward',
  budgetCommittedDelta: 1, ...patch });

function sequence(reason: ProgressStopReason): ProgressObservation[] {
  const table: Record<ProgressStopReason, ProgressObservation[]> = {
    NO_STATE_CHANGE: [neutral({stateChanged:false}),neutral({stateChanged:false}),neutral({stateChanged:false})],
    REPEATED_ACTION: [neutral({actionKey:'same'}),neutral({actionKey:'same'}),neutral({actionKey:'same'})],
    REPEATED_ERROR: [neutral({errorCode:'E_X'}),neutral({errorCode:'E_X'}),neutral({errorCode:'E_X'})],
    NO_NEW_EVIDENCE: [neutral({evidenceDelta:0}),neutral({evidenceDelta:0}),neutral({evidenceDelta:0})],
    PLAN_OSCILLATION: [neutral({planDirection:'backward',planRevision:2}),neutral({planDirection:'forward',planRevision:3}),
      neutral({planDirection:'backward',planRevision:4}),neutral({planDirection:'forward',planRevision:5})],
    BUDGET_STAGNATION: [neutral({budgetCommittedDelta:0}),neutral({budgetCommittedDelta:0}),neutral({budgetCommittedDelta:0})],
  }; return table[reason];
}

describe('W2-10 progress and restart recovery', () => {
  it.each(['NO_STATE_CHANGE','REPEATED_ACTION','REPEATED_ERROR','NO_NEW_EVIDENCE','PLAN_OSCILLATION','BUDGET_STAGNATION'] as const)
  ('stops with stable reason %s and persists it across restart', reason => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const repository = new ProgressStateRepository(db);
    let detector = new ProgressDetector('r1', repository, 3);
    let observed: ProgressStopReason|null = null;
    for (const item of sequence(reason)) observed = detector.observe(item).reasonCode;
    expect(observed).toBe(reason);
    detector = new ProgressDetector('r1', new ProgressStateRepository(db), 3);
    expect(detector.snapshot().stoppedReason).toBe(reason);
    db.close();
  });

  it('does not stop when state, action, evidence, plan and budget keep progressing', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const detector = new ProgressDetector('r2', new ProgressStateRepository(db), 3);
    for (let index=1; index<=12; index+=1) expect(detector.observe(neutral({ actionKey:`a${index}`,
      planRevision:index, planDirection:'forward', evidenceDelta:1, budgetCommittedDelta:1 })).reasonCode).toBeNull();
    expect(detector.snapshot().stoppedReason).toBeNull(); db.close();
  });

  it('continues counters after restart and stops on the third repeated action', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db); const repo = new ProgressStateRepository(db);
    new ProgressDetector('r3', repo, 3).observe(neutral({actionKey:'repeat'}));
    const restarted = new ProgressDetector('r3', new ProgressStateRepository(db), 3);
    expect(restarted.observe(neutral({actionKey:'repeat'})).reasonCode).toBeNull();
    expect(restarted.observe(neutral({actionKey:'repeat'})).reasonCode).toBe('REPEATED_ACTION'); db.close();
  });
});
