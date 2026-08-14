// src/application/memory/memoryToolService.ts — W3 Memory：memory_* 工具的 session-scoped 服务构造
// scope 只来自可信 ToolCtx.sessionId（agent 内部状态注入——参数不可伪造）；db 未装配时 fail-closed。
import { randomUUID } from 'node:crypto';
import type { ToolCtx } from '../../kernel/tools.js';
import { createMemoryService, type MemoryService } from '../memoryService.js';
import { openMemoryRepository } from '../../infrastructure/sqlite/memoryRepository.js';

const NO_DB: MemoryService = {
  append: () => ({ ok: false, error: { code: 'MEMORY_DB_UNAVAILABLE', message: 'memory 权威层未装配（db 缺失）', messageKey: 'memory.db_unavailable', retryable: false } }),
  update: () => ({ ok: false, error: { code: 'MEMORY_DB_UNAVAILABLE', message: 'memory 权威层未装配（db 缺失）', messageKey: 'memory.db_unavailable', retryable: false } }),
  delete: () => ({ ok: false, error: { code: 'MEMORY_DB_UNAVAILABLE', message: 'memory 权威层未装配（db 缺失）', messageKey: 'memory.db_unavailable', retryable: false } }),
  search: () => ({ ok: false, error: { code: 'MEMORY_DB_UNAVAILABLE', message: 'memory 权威层未装配（db 缺失）', messageKey: 'memory.db_unavailable', retryable: false } }),
  list: () => ({ ok: false, error: { code: 'MEMORY_DB_UNAVAILABLE', message: 'memory 权威层未装配（db 缺失）', messageKey: 'memory.db_unavailable', retryable: false } }),
};

/** memory_* 工具统一入口：session scope 服务（每次调用构造——repository 为无状态 db 闭包） */
export function memoryServiceForTool(ctx: ToolCtx): MemoryService {
  if (!ctx.db) return NO_DB;
  const repository = openMemoryRepository(ctx.db, {
    now: () => Date.now(),
    idFactory: prefix => `${prefix}-${randomUUID()}`,
  });
  return createMemoryService(repository, { sessionId: ctx.sessionId ?? 'default' });
}
