// src/application/memoryService.ts — 记忆应用服务权威（P0-05）：append/update/delete/search 唯一入口
// scope 只由注入的可信 context provider 构造；input 不能携带或伪造 session/project/global 作用域。
// repository 最底层执行 tier 隔离（write 必须声明 scope、update/delete 校验 ID 归属、global 读取显式 opt-in）。
import type {
  AppendMemory,
  MemoryPatch,
  MemoryQuery,
  MemoryRecord,
  MemoryRepository,
  MemorySearchHit,
} from '../domain/memory/memoryRepository.js';
import type { MemoryScope } from '../domain/memory/memoryScope.js';
import type { OperationResult } from '../protocol/results.js';

export interface MemoryScopeContext {
  sessionId?: string;
  projectId?: string;
  userArchive?: boolean;
  globalOptIn?: boolean;
}

export interface MemorySearchInput {
  text: string;
  limit?: number;
}

export interface MemoryService {
  append(input: AppendMemory): OperationResult<{ record: MemoryRecord; deduplicated: boolean }>;
  update(id: string, patch: MemoryPatch): OperationResult<MemoryRecord>;
  delete(id: string): OperationResult<void>;
  search(input: MemorySearchInput): OperationResult<readonly MemorySearchHit[]>;
}

/**
 * P0-05 权威委托：所有读写只走 MemoryRepository；scope 来自调用方装配时注入的可信 context，
 * 输入只提供查询词与条数——调用方无法借 sessionId 参数逃逸到其它会话。
 */
export function createMemoryService(repository: MemoryRepository, context: MemoryScopeContext): MemoryService {
  const scope = (): MemoryScope => ({
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
    ...(context.userArchive ? { userArchive: true } : {}),
    ...(context.globalOptIn ? { globalOptIn: true } : {}),
  });
  const query = (input: MemorySearchInput): MemoryQuery => ({
    text: input.text,
    limit: input.limit ?? 10,
    now: new Date().toISOString(),
  });
  return {
    append: input => repository.append(input, scope()),
    update: (id, patch) => repository.update(id, patch, scope()),
    delete: id => repository.delete(id, scope()),
    search: input => repository.search(query(input), scope()),
  };
}
