// src/application/toolExecutionService.ts — 工具执行应用服务：唯一委托 ToolExecutionPipeline，不直连实现/进程
import type { ToolExecutionPipeline, ToolExecutionRequest } from '../domain/tools/toolExecutionPipeline.js';
import type { OperationContext } from '../protocol/operationContext.js';
import type { OperationResult } from '../protocol/results.js';
import type { ToolExecutionReceipt } from '../domain/tools/toolExecutionPipeline.js';

export interface ToolExecutionService {
  execute(request: ToolExecutionRequest, context: OperationContext, signal: AbortSignal): Promise<OperationResult<ToolExecutionReceipt>>;
}

export function createToolExecutionService(pipeline: ToolExecutionPipeline): ToolExecutionService {
  return {
    execute(request, context, signal) {
      return pipeline.execute(request, context, signal);
    },
  };
}
