// src/wxnodus-ui/runtime/voiceRpc.ts — 语音 RPC compat 委托（W3-11：wxGateway 不再直接调用 kernel/voice 录音/转写）
import { requireLegacyPath } from '../../application/legacy/legacyGuard.js';
import type { RecordingSession } from '../../kernel/voice.js';
import type { StartRecordingOptions } from '../../kernel/voice.js';

export async function startVoiceRecording(
  dataDir: string,
  settings: Record<string, any> | undefined,
  env: NodeJS.ProcessEnv,
  options?: StartRecordingOptions,
) {
  requireLegacyPath('voice-record');
  const { startRecording } = await import('../../kernel/voice.js');
  return startRecording(dataDir, settings, env, options);
}

export async function stopVoiceTranscribe(
  rec: RecordingSession,
  dataDir: string,
  settings: Record<string, any> | undefined,
) {
  requireLegacyPath('voice-transcribe');
  const { stopAndTranscribe } = await import('../../kernel/voice.js');
  return stopAndTranscribe(rec, dataDir, settings);
}
