// src/domain/memory/embeddingJobs.ts — durable embedding outbox 的任务模型
export interface EmbeddingJob { id: string; recordId: string; generation: number; state: 'pending'|'processing'|'ready'|'failed'|'tombstoned'; attempts: number; createdAt: number; updatedAt: number; leaseOwner: string | null; leaseUntil: number | null }
