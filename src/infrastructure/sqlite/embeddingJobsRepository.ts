// src/infrastructure/sqlite/embeddingJobsRepository.ts — durable embedding outbox：lease claim / generation fence / dead letter
import type { Db } from '../../store/db.js';
import type { EmbeddingJob } from '../../domain/memory/embeddingJobs.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

const mapJob = (row: Record<string, unknown>): EmbeddingJob => ({ id: String(row.id), recordId: String(row.record_id), generation: Number(row.generation), state: row.state as EmbeddingJob['state'], attempts: Number(row.attempts), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), leaseOwner: row.lease_owner === null ? null : String(row.lease_owner), leaseUntil: row.lease_until === null ? null : Number(row.lease_until) });

export function createEmbeddingJobsRepository(db: Db) {
  const claim = db.transaction((workerId: string, now: number, leaseMs: number, maxAttempts: number) => {
    const row = db.prepare(`SELECT * FROM embedding_jobs WHERE attempts < @max AND available_at<=@now AND (state IN ('pending','failed') OR (state='processing' AND lease_until<=@now)) ORDER BY created_at,id LIMIT 1`).get({ max: maxAttempts, now }) as Record<string, unknown> | undefined;
    if (!row) return null;
    db.prepare(`UPDATE embedding_jobs SET state='processing',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?`).run(workerId, now + leaseMs, now, row.id);
    return mapJob({ ...row, state: 'processing', attempts: Number(row.attempts) + 1, lease_owner: workerId, lease_until: now + leaseMs, updated_at: now });
  });
  return {
    claim(workerId: string, now: number, leaseMs: number, maxAttempts: number) { return ok(claim(workerId, now, leaseMs, maxAttempts)); },
    complete(job: EmbeddingJob, embedding: readonly number[], now: number) {
      return db.transaction(() => {
        const record = db.prepare(`SELECT generation,tombstoned_at FROM memory_records WHERE id=?`).get(job.recordId) as { generation: number; tombstoned_at: number | null } | undefined;
        if (!record || record.tombstoned_at !== null || record.generation !== job.generation) {
          db.prepare(`UPDATE embedding_jobs SET state='tombstoned',last_error_code='EMBEDDING_GENERATION_STALE',updated_at=? WHERE id=?`).run(now, job.id);
          return err(gatewayError('EMBEDDING_GENERATION_STALE', 'embedding generation 已过期', 'embedding.generation.stale'));
        }
        db.prepare(`INSERT INTO memory_vectors VALUES (?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET generation=excluded.generation,embedding_json=excluded.embedding_json,updated_at=excluded.updated_at`).run(job.recordId, job.generation, JSON.stringify(embedding), now);
        db.prepare(`UPDATE memory_records SET embedding_state='ready',updated_at=? WHERE id=? AND generation=?`).run(now, job.recordId, job.generation);
        db.prepare(`UPDATE embedding_jobs SET state='ready',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?`).run(now, job.id);
        return ok(undefined);
      })();
    },
    fail(job: EmbeddingJob, errorCode: string, now: number, maxAttempts: number) {
      if (job.attempts >= maxAttempts) {
        db.transaction(() => {
          db.prepare(`UPDATE embedding_jobs SET state='failed',lease_owner=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=?`).run(errorCode, now, job.id);
          db.prepare(`INSERT OR REPLACE INTO embedding_dead_letter VALUES (?,?,?,?,?,?)`).run(job.id, job.recordId, job.generation, errorCode, job.attempts, now);
          db.prepare(`UPDATE memory_records SET embedding_state='failed',updated_at=? WHERE id=? AND generation=?`).run(now, job.recordId, job.generation);
        })();
        return err(gatewayError('EMBEDDING_JOB_DEAD_LETTERED', 'embedding job 已进入 dead letter', 'embedding.job.dead_lettered'));
      }
      db.prepare(`UPDATE embedding_jobs SET state='failed',available_at=?,lease_owner=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=?`).run(now, errorCode, now, job.id);
      return err(gatewayError(errorCode, 'embedding job 失败', 'embedding.job.failed', { retryable: true }));
    },
  };
}
export type EmbeddingJobsRepository = ReturnType<typeof createEmbeddingJobsRepository>;
