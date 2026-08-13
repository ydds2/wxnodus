import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryCurator } from '../../src/domain/memory/memoryCurator.js';
import { rankMemoryCandidates } from '../../src/domain/memory/memoryRanking.js';
import type { AppendMemory } from '../../src/domain/memory/memoryRepository.js';
import type { MemoryScope } from '../../src/domain/memory/memoryScope.js';
import { createEmbeddingWorker } from '../../src/infrastructure/sqlite/embeddingWorker.js';
import { createEmbeddingJobsRepository } from '../../src/infrastructure/sqlite/embeddingJobsRepository.js';
import { migrateMemory } from '../../src/infrastructure/sqlite/memoryMigrations.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import type { Db } from '../../src/store/db.js';

const START = Date.parse('2026-08-13T00:00:00.000Z');
const scopeA: MemoryScope = { sessionId: 'session-a', projectId: 'project-a' };
const scopeB: MemoryScope = { sessionId: 'session-b', projectId: 'project-a' };
let nowMs = START;
let serial = 0;
let db: Db;
let repository: ReturnType<typeof openMemoryRepository>;
let jobs: ReturnType<typeof createEmbeddingJobsRepository>;
const iso = (ms: number) => new Date(ms).toISOString();
function input(content: string, patch: Partial<AppendMemory> = {}): AppendMemory {
  return {
    role: 'user', content, salience: 0.5,
    retention: { class: 'session', retainUntil: null },
    provenance: {
      sourceType: 'conversation', sourceId: 'turn-1', capturedAt: iso(nowMs), actorId: 'user-1',
      correlationId: `corr-${serial + 1}`, policySnapshotId: 'policy-1', sourceTrust: 0.8,
    },
    ...patch,
  };
}
beforeEach(() => {
  nowMs = START; serial = 0;
  db = new Database(':memory:') as Db;
  migrateMemory(db, { embeddingDimensions: 3 });
  repository = openMemoryRepository(db, { now: () => nowMs, idFactory: prefix => `${prefix}-${++serial}` });
  jobs = createEmbeddingJobsRepository(db);
});
afterEach(() => db.close());

describe('W1-06 transaction, scope, dedup, provenance', () => {
  it('rolls back primary/FTS when outbox insert fails and otherwise gives read-your-writes', () => {
    db.exec(`CREATE TRIGGER reject_job BEFORE INSERT ON embedding_jobs BEGIN SELECT RAISE(ABORT,'forced'); END;`);
    const failed = repository.append(input('transactional memory'), scopeA);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('MEMORY_TRANSACTION_FAILED');
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_records`).get() as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_fts`).get() as { c: number }).c).toBe(0);
    db.exec(`DROP TRIGGER reject_job`);
    const appended = repository.append(input('transactional memory'), scopeA);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(repository.search({ text: 'transactional', limit: 10, now: iso(nowMs) }, scopeA)).toMatchObject({ ok: true });
    expect(db.prepare(`SELECT state FROM embedding_jobs WHERE record_id=?`).get(appended.value.record.id)).toEqual({ state: 'pending' });
  });

  it('deduplicates only within the same scope and merges durable provenance/sourceTrust', () => {
    const first = repository.append(input('same normalized content'), scopeA);
    const duplicate = repository.append(input('ｓａｍｅ normalized content', {
      provenance: {
        sourceType: 'file', sourceId: 'file-1', sourceUri: 'file:///workspace/a.txt', capturedAt: iso(nowMs),
        actorId: 'user-1', correlationId: 'corr-file', policySnapshotId: 'policy-1', sourceTrust: 0.95,
      },
    }), scopeA);
    const otherScope = repository.append(input('same normalized content'), scopeB);
    expect(first.ok && duplicate.ok && otherScope.ok).toBe(true);
    if (!first.ok || !duplicate.ok || !otherScope.ok) return;
    expect(duplicate.value).toMatchObject({ deduplicated: true, record: { id: first.value.record.id, dedupCount: 2, sourceTrust: 0.95 } });
    expect(duplicate.value.record.provenance.map(p => p.sourceId)).toEqual(['turn-1', 'file-1']);
    expect(otherScope.value.record.id).not.toBe(first.value.record.id);
    expect((db.prepare(`SELECT COUNT(*) c FROM embedding_jobs WHERE record_id=?`).get(first.value.record.id) as { c: number }).c).toBe(1);
  });

  it('applies scope before FTS/vector candidates and requires global opt-in', () => {
    repository.append(input('shared keyword from A'), scopeA);
    repository.append(input('shared keyword from B'), scopeB);
    repository.append(input('shared keyword global'), { globalOptIn: true });
    const privateHits = repository.search({ text: 'shared', limit: 10, now: iso(nowMs) }, scopeA);
    expect(privateHits.ok && privateHits.value.map(x => x.record.content)).toEqual(['shared keyword from A']);
    const globalHits = repository.search({ text: 'shared', limit: 10, now: iso(nowMs) }, { ...scopeA, globalOptIn: true });
    expect(globalHits.ok && globalHits.value.map(x => x.record.content).sort()).toEqual(['shared keyword from A', 'shared keyword global']);
  });
});

describe('W1-06 generation, stale time, orphan and retry', () => {
  it('rejects old generation writeback and leaves no stale index after delete', () => {
    const appended = repository.append(input('generation one'), scopeA);
    if (!appended.ok) throw new Error(appended.error.code);
    const oldJob = jobs.claim('worker-1', nowMs, 1_000, 3);
    if (!oldJob.ok || !oldJob.value) throw new Error('expected job');
    expect(repository.update(appended.value.record.id, { content: 'generation two' }, scopeA)).toMatchObject({ ok: true, value: { generation: 2 } });
    const stale = jobs.complete(oldJob.value, [1, 0, 0], nowMs);
    expect(stale).toMatchObject({ ok: false, error: { code: 'EMBEDDING_GENERATION_STALE' } });
    expect(db.prepare(`SELECT content FROM memory_fts WHERE record_id=?`).get(appended.value.record.id)).toEqual({ content: 'generation two' });
    expect(repository.delete(appended.value.record.id, scopeA).ok).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_fts WHERE record_id=?`).get(appended.value.record.id) as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE record_id=?`).get(appended.value.record.id) as { c: number }).c).toBe(0);
  });

  it('detects max stale/orphan, reclaims an expired lease, and dead-letters repeated failure', async () => {
    const appended = repository.append(input('stale embedding'), scopeA);
    if (!appended.ok) throw new Error(appended.error.code);
    expect(jobs.claim('dead-worker', nowMs, 1_000, 2).ok).toBe(true);
    db.prepare(`INSERT INTO memory_vectors VALUES ('orphan',1,'[0,0,1]',?)`).run(nowMs);
    nowMs += 61_000;
    expect(repository.inspectIndexHealth(nowMs, 60_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EMBEDDING_MAX_STALE_EXCEEDED', recordId: appended.value.record.id }),
      expect.objectContaining({ code: 'EMBEDDING_ORPHAN_VECTOR', recordId: 'orphan' }),
    ]));
    const reclaim = createEmbeddingWorker({ jobs, repository, workerId: 'worker-2', leaseMs: 5_000, maxAttempts: 2, maxStaleTimeMs: 60_000, now: () => nowMs, embed: async () => [1, 0, 0] });
    expect(await reclaim.runOnce()).toMatchObject({ ok: true, value: { processed: true } });

    repository.append(input('cannot embed'), scopeA);
    const failing = createEmbeddingWorker({ jobs, repository, workerId: 'worker-fail', leaseMs: 5_000, maxAttempts: 2, maxStaleTimeMs: 60_000, now: () => nowMs, embed: async () => { throw new Error('offline'); } });
    expect((await failing.runOnce()).ok).toBe(false);
    nowMs += 1;
    expect(await failing.runOnce()).toMatchObject({ ok: false, error: { code: 'EMBEDDING_JOB_DEAD_LETTERED' } });
  });
});

describe('W1-06 six-component ranking, retention, curator and rebuild', () => {
  it('returns six normalized components and ranks sourceTrust/scopeWeight in the same score', () => {
    const ranked = rankMemoryCandidates([
      { id: 'global-low', fts: 0.8, vector: 0.8, recency: 0.5, salience: 0.5, sourceTrust: 0.1, scopeWeight: 0.4 },
      { id: 'session-trusted', fts: 0.8, vector: 0.8, recency: 0.5, salience: 0.5, sourceTrust: 1, scopeWeight: 1 },
    ]);
    expect(ranked.map(x => x.id)).toEqual(['session-trusted', 'global-low']);
    expect(ranked[0]?.score).toBeCloseTo(0.765);
    expect(ranked[0]?.components).toEqual({ fts: 0.8, vector: 0.8, recency: 0.5, salience: 0.5, sourceTrust: 1, scopeWeight: 1 });
    for (const value of Object.values(ranked[0]!.components)) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(ranked[0]!.components)) expect(value).toBeLessThanOrEqual(1);
  });

  it('keeps curator dry-run read-only, applies retention atomically, and preserves provenance', () => {
    const expired = repository.append(input('expired but auditable', { retention: { class: 'session', retainUntil: '2026-08-12T00:00:00.000Z' } }), scopeA);
    if (!expired.ok) throw new Error(expired.error.code);
    db.prepare(`INSERT INTO memory_vectors VALUES (?,?,?,?)`).run(expired.value.record.id, 1, '[1,0,0]', nowMs);
    db.prepare(`UPDATE memory_records SET embedding_state='ready' WHERE id=?`).run(expired.value.record.id);
    const curator = createMemoryCurator(repository);
    expect(curator.run({ mode: 'dry-run', now: iso(nowMs) })).toMatchObject({ ok: true, value: { applied: 0, actions: [{ recordId: expired.value.record.id }] } });
    expect(db.prepare(`SELECT tombstoned_at FROM memory_records WHERE id=?`).get(expired.value.record.id)).toEqual({ tombstoned_at: null });
    expect(curator.run({ mode: 'apply', now: iso(nowMs) })).toMatchObject({ ok: true, value: { applied: 1 } });
    const row = db.prepare(`SELECT provenance_json,tombstoned_at FROM memory_records WHERE id=?`).get(expired.value.record.id) as { provenance_json: string; tombstoned_at: number };
    expect(JSON.parse(row.provenance_json)[0].sourceId).toBe('turn-1');
    expect(row.tombstoned_at).toBe(nowMs);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_fts WHERE record_id=?`).get(expired.value.record.id) as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE record_id=?`).get(expired.value.record.id) as { c: number }).c).toBe(0);
  });

  it('rebuilds idempotently from active primary state and removes orphan issues', () => {
    repository.append(input('rebuild one'), scopeA);
    repository.append(input('rebuild two'), scopeA);
    db.prepare(`INSERT INTO memory_vectors VALUES ('orphan',1,'[0,0,1]',?)`).run(nowMs);
    const first = repository.rebuild(scopeA);
    const second = repository.rebuild(scopeA);
    expect(first).toMatchObject({ ok: true, value: { activeRecords: 2, ftsRows: 2, queuedEmbeddings: 2, removedOrphans: 1 } });
    expect(second).toMatchObject({ ok: true, value: { activeRecords: 2, ftsRows: 2, queuedEmbeddings: 2, removedOrphans: 0 } });
    expect(repository.inspectIndexHealth(nowMs, 60_000).some(x => x.code === 'EMBEDDING_ORPHAN_VECTOR')).toBe(false);
  });
});
