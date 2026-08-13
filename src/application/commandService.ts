// src/application/commandService.ts — 命令执行应用服务端口
import type { OperationResult } from '../protocol/results.js';

export interface CommandService {
  execute(input: { raw: string; sessionId: string }): Promise<OperationResult<{ output: string }>>;
}
