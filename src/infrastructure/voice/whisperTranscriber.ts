// src/infrastructure/voice/whisperTranscriber.ts — whisper.cpp 转写适配器（executable + argv，无 shell 拼接）
import { spawnVoiceWorker } from './voiceWorkerProtocol.js';
import type { OperationResult } from '../../protocol/results.js';

export interface WhisperTranscriberOptions {
  executable?: string;
  modelPath: string;
  audioPath: string;
  language?: 'auto' | 'zh' | 'en';
  timeoutMs?: number;
}

const error = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class WhisperTranscriber {
  constructor(private readonly executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli') {}

  async transcribe(options: WhisperTranscriberOptions, signal: AbortSignal): Promise<OperationResult<{ text: string }>> {
    const args = ['-m', options.modelPath, '-f', options.audioPath, '-otxt', '-nt'];
    if (options.language && options.language !== 'auto') args.push('-l', options.language);
    try {
      const result = await spawnVoiceWorker(this.executable, args, { timeoutMs: options.timeoutMs ?? 120_000 }, signal);
      if (result.aborted) return error('VOICE_WORKER_ABORTED');
      if (result.timedOut) return error('VOICE_WORKER_TIMEOUT');
      if (result.exitCode !== 0) return error('VOICE_WORKER_CRASHED', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) });
      return { ok: true, value: { text: result.stdout.trim() } };
    } catch (spawnError) {
      return error('VOICE_WORKER_SPAWN_FAILED', { message: String((spawnError as Error)?.message ?? spawnError) });
    }
  }
}
