// src/application/promptService.ts — Prompt 提交应用服务端口
import type { OperationResult } from '../protocol/results.js';

export interface PromptService {
  submit(input: { sessionId: string; text: string }): Promise<OperationResult<{ runId: string }>>;
}
