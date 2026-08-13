// src/application/pty/ptyService.ts — PTY 应用服务：Domain PtyPort 的 Application 面（四个入口经此打开终端会话）
import type { PtyOpenRequest, PtyPort, PtySessionPort } from '../../domain/pty/pty.js';
import type { OperationResult } from '../../protocol/results.js';

export class PtyService {
  constructor(private readonly port: PtyPort) {}

  open(request: PtyOpenRequest, signal: AbortSignal): Promise<OperationResult<PtySessionPort>> {
    return this.port.open(request, signal);
  }
}
