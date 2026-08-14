// src/domain/memory/memoryRepository.ts — 记忆仓储端口：事务、作用域、保留与 embedding outbox 的唯一写入口
import type { MemoryScope, MemoryScopeTier } from './memoryScope.js';
import type { MemoryRankingComponents } from './memoryRanking.js';
import type { OperationResult } from '../../protocol/results.js';

export interface MemoryProvenanceInput { sourceType: 'conversation'|'tool'|'file'|'image'|'import'|'curator'; sourceId: string; sourceUri?: string; capturedAt: string; actorId: string; correlationId: string; policySnapshotId: string; sourceTrust: number }
export interface MemoryProvenance extends MemoryProvenanceInput { contentHash: string }
export interface RetentionPolicy { class: 'ephemeral'|'session'|'project'|'archive'|'audit'; retainUntil: string | null }
export interface AppendMemory { role: 'user'|'assistant'|'system'|'tool'; content: string; salience: number; retention: RetentionPolicy; provenance: MemoryProvenanceInput }
export interface MemoryRecord {
  id: string; scopeTier: MemoryScopeTier; scopeKey: string; role: AppendMemory['role']; content: string; contentHash: string;
  generation: number; embeddingState: 'pending'|'processing'|'ready'|'failed'|'tombstoned'; salience: number;
  provenance: readonly MemoryProvenance[]; sourceTrust: number; retention: RetentionPolicy;
  createdAt: string; updatedAt: string; lastSeenAt: string; dedupCount: number; tombstonedAt: string | null;
}
export interface MemoryPatch { content?: string; salience?: number; retention?: RetentionPolicy; provenance?: MemoryProvenanceInput }
export interface MemoryQuery { text: string; embedding?: readonly number[]; limit: number; now: string }
export interface MemorySearchHit { record: MemoryRecord; score: number; components: MemoryRankingComponents }
export interface RebuildReport { activeRecords: number; ftsRows: number; queuedEmbeddings: number; removedOrphans: number }
export interface IndexHealthIssue { code: 'EMBEDDING_MAX_STALE_EXCEEDED'|'EMBEDDING_ORPHAN_VECTOR'|'EMBEDDING_VECTOR_MISSING'; recordId: string; ageMs?: number }
export interface RetentionAction { recordId: string; action: 'tombstone'; retainUntil: string }
export interface MemoryRepository {
  append(input: AppendMemory, scope: MemoryScope): OperationResult<{ record: MemoryRecord; deduplicated: boolean }>;
  update(id: string, patch: MemoryPatch, scope: MemoryScope): OperationResult<MemoryRecord>;
  delete(id: string, scope: MemoryScope): OperationResult<void>;
  search(query: MemoryQuery, scope: MemoryScope): OperationResult<MemorySearchHit[]>;
  /** W3 Memory：作用域内活跃记录列表（updated_at 降序，limit 有界）——/memory list 数据源 */
  list(scope: MemoryScope, options: { limit: number }): OperationResult<MemoryRecord[]>;
  rebuild(scope: MemoryScope): OperationResult<RebuildReport>;
  inspectIndexHealth(nowMs: number, maxStaleTimeMs: number): IndexHealthIssue[];
  retentionPlan(nowMs: number): RetentionAction[];
  applyRetention(actions: readonly RetentionAction[], nowMs: number): OperationResult<number>;
}
