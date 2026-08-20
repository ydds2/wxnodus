// src/application/sessionService.ts — Session 应用服务端口
import type { OperationResult } from '../protocol/results.js';

export interface SessionService {
  open(input: { sessionId?: string }): Promise<OperationResult<{ sessionId: string }>>;
}
