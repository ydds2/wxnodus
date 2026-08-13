// src/application/voice/voiceSessionService.ts — 语音会话服务：可取消转写（ProcessSupervisor 确认进程树退出）+ 保留策略清理
import { randomUUID } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import type { AudioRef, TranscriptRef } from '../../domain/voice/voiceSession.js';
import { transcriptRefFor } from '../../domain/voice/voiceSession.js';
import type { VoiceSessionSnapshot } from '../../domain/voice/voiceState.js';

interface ProcessResult { processId: number; exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }
interface SupervisorPort {
  spawn(executable: string, args: string[], options: { timeoutMs: number }, signal: AbortSignal): Promise<ProcessResult>;
  terminateTree(processId: number, deadlineMs: number): Promise<OperationResult<void>>;
}
interface TempPort { remove(path: string): Promise<OperationResult<void>> }

const error = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class VoiceSessionService {
  private current: VoiceSessionSnapshot = {
    id: randomUUID(), state: 'idle', mode: 'push-to-talk', selectedDeviceId: null,
  };

  constructor(private readonly deps: { supervisor: SupervisorPort; temp: TempPort; sttReady(): boolean }) {}
  snapshot(): VoiceSessionSnapshot { return structuredClone(this.current); }

  async start(mode: VoiceSessionSnapshot['mode'], _signal: AbortSignal): Promise<OperationResult<VoiceSessionSnapshot>> {
    if (!this.deps.sttReady()) return error('VOICE_STT_UNAVAILABLE');
    this.current = { ...this.current, mode, state: 'listening' };
    return { ok: true, value: this.snapshot() };
  }

  async transcribe(audio: AudioRef, signal: AbortSignal): Promise<OperationResult<{ transcriptRef: TranscriptRef }>> {
    this.current = { ...this.current, state: 'transcribing' };
    let spawned = false;
    try {
      const result = await this.deps.supervisor.spawn('whisper-cli', ['-f', audio.path], { timeoutMs: 120_000 }, signal);
      spawned = true;
      if (result.aborted || signal.aborted) {
        const stopped = await this.deps.supervisor.terminateTree(result.processId, 5_000);
        if (!stopped.ok) return error('VOICE_PROCESS_TREE_STILL_RUNNING', { processId: result.processId });
        return error('VOICE_WORKER_ABORTED');
      }
      if (result.timedOut) return error('VOICE_WORKER_TIMEOUT', { processId: result.processId });
      if (result.exitCode !== 0) return error('VOICE_WORKER_CRASHED', { processId: result.processId, exitCode: result.exitCode });
      return { ok: true, value: { transcriptRef: transcriptRefFor(audio.id) } };
    } catch {
      return error('VOICE_WORKER_SPAWN_FAILED', spawned ? undefined : { audioId: audio.id });
    } finally {
      if (audio.retention === 'ephemeral') await this.deps.temp.remove(audio.path);
      this.current = { ...this.current, state: 'idle' };
    }
  }
}
