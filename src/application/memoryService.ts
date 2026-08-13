// src/application/memoryService.ts — 记忆检索应用服务端口
import type { OperationResult } from '../protocol/results.js';

export interface MemoryService {
  search(input: { query: string; sessionId: string }): Promise<OperationResult<readonly unknown[]>>;
}
