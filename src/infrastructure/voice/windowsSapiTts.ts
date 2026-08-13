// src/infrastructure/voice/windowsSapiTts.ts — Windows SAPI 语音合成适配器（非交互 PowerShell 脚本作为单一 argv，无 shell 拼接）
import { spawnVoiceWorker } from './voiceWorkerProtocol.js';
import type { OperationResult } from '../../protocol/results.js';

export interface SapiTtsOptions { timeoutMs?: number }

const SAPI_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$voice.SetOutputToDefaultAudioDevice()',
  '$voice.Rate = 0',
  '$voice.Speak($env:WXNODUS_SAPI_TEXT)',
].join('; ');

const error = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class WindowsSapiTts {
  async speak(text: string, signal: AbortSignal, options: SapiTtsOptions = {}): Promise<OperationResult<void>> {
    if (process.platform !== 'win32') return error('VOICE_SAPI_UNAVAILABLE', { platform: process.platform });
    try {
      // 文本经环境变量传入（无 shell 拼接、无 argv 转义风险）
      const result = await spawnVoiceWorker('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SAPI_SCRIPT], {
        timeoutMs: options.timeoutMs ?? 120_000,
        env: { ...process.env, WXNODUS_SAPI_TEXT: text },
      }, signal);
      if (result.aborted) return error('VOICE_WORKER_ABORTED');
      if (result.timedOut) return error('VOICE_WORKER_TIMEOUT');
      if (result.exitCode !== 0) return error('VOICE_SAPI_UNAVAILABLE', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) });
      return { ok: true, value: undefined };
    } catch (spawnError) {
      return error('VOICE_WORKER_SPAWN_FAILED', { message: String((spawnError as Error)?.message ?? spawnError) });
    }
  }
}
