// src/application/build/buildVerificationCoordinator.ts — 重启读回协调器（计划原文）：
// 证明真实进程替换（第二进程 ID 必须不同）、端口释放、真实业务读回一致
import type { OperationResult } from '../../protocol/results.js';
interface RuntimePort {
  start(signal: AbortSignal): Promise<{ processId: number; port: number; stdoutRef: string; stderrRef: string }>;
  ready(processId: number, signal: AbortSignal): Promise<boolean>;
  stopTree(processId: number, signal: AbortSignal): Promise<boolean>;
  portReleased(port: number, signal: AbortSignal): Promise<boolean>;
}
interface PersistencePort {
  seed(processId: number, signal: AbortSignal): Promise<{ token: string; expected: unknown }>;
  readBack(processId: number, token: { token: string; expected: unknown }, signal: AbortSignal): Promise<unknown>;
}
const fail = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});
export class BuildVerificationCoordinator {
  constructor(private readonly runtime: RuntimePort, private readonly persistence: PersistencePort) {}
  async verifyRestart(snapshot: { runId: string; artifactHash: string; verificationId: string }, signal: AbortSignal): Promise<OperationResult<{
    firstProcessId: number; secondProcessId: number; attachmentRefs: string[]; snapshot: typeof snapshot;
  }>> {
    const first = await this.runtime.start(signal);
    if (!await this.runtime.ready(first.processId, signal)) return fail('BUILD_PROCESS_NOT_READY');
    const token = await this.persistence.seed(first.processId, signal);
    if (!await this.runtime.stopTree(first.processId, signal)) return fail('BUILD_PROCESS_DID_NOT_STOP');
    if (!await this.runtime.portReleased(first.port, signal)) return fail('BUILD_PORT_NOT_RELEASED');
    const second = await this.runtime.start(signal);
    if (second.processId === first.processId) return fail('BUILD_RESTART_REUSED_OLD_PROCESS');
    if (!await this.runtime.ready(second.processId, signal)) return fail('BUILD_PROCESS_NOT_READY');
    const observed = await this.persistence.readBack(second.processId, token, signal);
    if (JSON.stringify(observed) !== JSON.stringify(token.expected)) return fail('BUILD_READBACK_MISMATCH');
    return { ok: true, value: {
      firstProcessId: first.processId,
      secondProcessId: second.processId,
      attachmentRefs: [first.stdoutRef, first.stderrRef, second.stdoutRef, second.stderrRef],
      snapshot,
    } };
  }
}
