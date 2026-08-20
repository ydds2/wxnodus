// src/infrastructure/voice/ffmpegRecorder.ts — ffmpeg dshow 录音适配器（executable + argv，无 shell 拼接）
import { spawnVoiceWorker, terminateVoiceWorkerTree, type VoiceWorkerResult } from './voiceWorkerProtocol.js';
import type { OperationResult } from '../../protocol/results.js';

export interface FfmpegRecorderOptions {
  executable?: string;
  deviceId: string;
  outputPath: string;
  sampleRate?: number;
  timeoutMs?: number;
}

export interface RecordingHandle {
  processId: number;
  /** 正常停止（q → flush → exit 0） */
  stop(deadlineMs?: number): Promise<OperationResult<void>>;
}

export class FfmpegRecorder {
  constructor(private readonly executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') {}

  start(options: FfmpegRecorderOptions, signal: AbortSignal): Promise<OperationResult<RecordingHandle>> {
    const sampleRate = options.sampleRate ?? 16_000;
    const args = ['-y', '-f', 'dshow', '-i', `audio=${options.deviceId}`, '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', options.outputPath];
    return spawnVoiceWorker(this.executable, args, { timeoutMs: options.timeoutMs ?? 600_000 }, signal).then(result => {
      if (!result.aborted && result.exitCode !== null && result.exitCode !== 0) {
        return { ok: false, error: { code: 'VOICE_WORKER_CRASHED', message: `ffmpeg exited ${result.exitCode}`, messageKey: 'VOICE_WORKER_CRASHED', retryable: false, details: { processId: result.processId, stderr: result.stderr.slice(0, 300) } } } as OperationResult<RecordingHandle>;
      }
      if (result.aborted) {
        return { ok: false, error: { code: 'VOICE_WORKER_ABORTED', message: 'recording aborted', messageKey: 'VOICE_WORKER_ABORTED', retryable: false } } as OperationResult<RecordingHandle>;
      }
      return { ok: true as const, value: {
        processId: result.processId,
        stop: (deadlineMs = 5_000) => terminateVoiceWorkerTree(result.processId, deadlineMs),
      } };
    }).catch(error => ({ ok: false, error: { code: 'VOICE_WORKER_SPAWN_FAILED', message: String((error as Error)?.message ?? error), messageKey: 'VOICE_WORKER_SPAWN_FAILED', retryable: false } }) as OperationResult<RecordingHandle>);
  }
}

export type { VoiceWorkerResult };
