// src/infrastructure/build/buildProcessAdapter.ts — 构建进程适配：ProcessSupervisor 注入（start/ready/stopTree/portReleased），
// 生产由真实 supervisor 提供；测试注入受控实现
import type { OperationResult } from '../../protocol/results.js';

export interface BuildProcessHandle { processId: number; port: number; stdoutRef: string; stderrRef: string }
export interface BuildProcessRuntimePort {
  start(signal: AbortSignal): Promise<BuildProcessHandle>;
  ready(processId: number, signal: AbortSignal): Promise<boolean>;
  stopTree(processId: number, signal: AbortSignal): Promise<boolean>;
  portReleased(port: number, signal: AbortSignal): Promise<boolean>;
}

const fail = <T = never>(code: string): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

/** 组合端口：把 BuildProcessRuntimePort 包装成带稳定失败码的 adapter（供 BuildVerificationCoordinator 使用） */
export class BuildProcessAdapter {
  constructor(private readonly runtime: BuildProcessRuntimePort) {}

  get ports(): BuildProcessRuntimePort { return this.runtime; }

  async startAndWaitReady(signal: AbortSignal): Promise<OperationResult<BuildProcessHandle>> {
    const handle = await this.runtime.start(signal);
    if (!await this.runtime.ready(handle.processId, signal)) return fail('BUILD_PROCESS_NOT_READY');
    return { ok: true, value: handle };
  }

  async stopAndRelease(handle: BuildProcessHandle, signal: AbortSignal): Promise<OperationResult<void>> {
    if (!await this.runtime.stopTree(handle.processId, signal)) return fail('BUILD_PROCESS_DID_NOT_STOP');
    if (!await this.runtime.portReleased(handle.port, signal)) return fail('BUILD_PORT_NOT_RELEASED');
    return { ok: true, value: undefined };
  }
}
