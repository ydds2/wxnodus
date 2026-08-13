// src/infrastructure/sqlite/embeddingWorker.ts — embedding 消费者：claim → embed → generation-fenced 写回；lease 到期可 reclaim
import type { MemoryRepository, MemoryRecord } from '../../domain/memory/memoryRepository.js';
import type { EmbeddingJobsRepository } from './embeddingJobsRepository.js';
import { ok } from '../../protocol/results.js';

export function createEmbeddingWorker(options: { jobs: EmbeddingJobsRepository; repository: MemoryRepository & { getActive(id: string): MemoryRecord | null }; workerId: string; leaseMs: number; maxAttempts: number; maxStaleTimeMs: number; now(): number; embed(text: string): Promise<readonly number[]> }) {
  return {
    async runOnce() {
      const claimed = options.jobs.claim(options.workerId, options.now(), options.leaseMs, options.maxAttempts);
      if (!claimed.ok || !claimed.value) return claimed.ok ? ok({ processed: false }) : claimed;
      const record = options.repository.getActive(claimed.value.recordId);
      if (!record) return options.jobs.complete(claimed.value, [], options.now());
      try { const embedding = await options.embed(record.content); const done = options.jobs.complete(claimed.value, embedding, options.now()); return done.ok ? ok({ processed: true, recordId: record.id }) : done; }
      catch { return options.jobs.fail(claimed.value, 'EMBEDDING_PROVIDER_FAILED', options.now(), options.maxAttempts); }
    },
    health() { return options.repository.inspectIndexHealth(options.now(), options.maxStaleTimeMs); },
  };
}
