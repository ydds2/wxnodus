// src/application/computer/computerFrontendHandler.ts — 四入口共享 handler：CLI/Wire/HTTP/TUI 对同一动作返回同一决策（计划原文）
export function createComputerFrontendHandler(
  frontend: string,
  service: { execute(request: unknown, context: unknown, signal: AbortSignal): Promise<unknown> },
) {
  return {
    async handle(request: unknown, context: unknown, signal: AbortSignal) {
      void frontend;
      return service.execute(request, context, signal);
    },
  };
}
