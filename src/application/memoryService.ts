// src/application/memoryService.ts — 记忆检索应用服务端口（W1-02 契约）＋ W1-06 repository 委托
import type { MemoryRepository } from '../domain/memory/memoryRepository.js';
import type { MemoryScope } from '../domain/memory/memoryScope.js';
import type { OperationResult } from '../protocol/results.js';

export interface MemoryService {
  search(input: { query: string; sessionId: string }): Promise<OperationResult<readonly unknown[]>>;
}

/**
 * W1-06 委托：所有检索只走 MemoryRepository（scope 隔离 + 六分量排序 + 事务索引），
 * 不再直连 messages_fts/archival_vec。scope 由调用方会话决定；global 需显式 opt-in。
 */
export function createMemoryService(repository: MemoryRepository, opts: { sessionId(): string }): MemoryService {
  return {
    async search(input) {
      const scope: MemoryScope = { sessionId: input.sessionId || opts.sessionId() };
      const result = repository.search({ text: input.query, limit: 10, now: new Date().toISOString() }, scope);
      if (!result.ok) return result;
      return { ok: true, value: result.value.map(hit => ({ record: hit.record, score: hit.score })) };
    },
  };
}
