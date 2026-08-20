// src/domain/voice/voiceState.ts — 语音会话状态机（不可非法跳变：非法迁移抛 VOICE_ILLEGAL_TRANSITION）
import type { GatewayError } from '../../protocol/errors.js';
export type VoiceState = 'idle' | 'listening' | 'speech_detected' | 'transcribing' |
  'thinking' | 'speaking' | 'cancelling' | 'stopping' | 'error';
export type VoiceMode = 'push-to-talk' | 'continuous' | 'wake-word';
export interface VoiceSessionSnapshot {
  id: string;
  state: VoiceState;
  mode: VoiceMode;
  selectedDeviceId: string | null;
  error?: GatewayError;
}
const allowed: Record<VoiceState, readonly VoiceState[]> = {
  idle: ['listening'],
  listening: ['speech_detected', 'cancelling', 'stopping', 'error'],
  speech_detected: ['transcribing', 'cancelling', 'error'],
  transcribing: ['thinking', 'cancelling', 'error'],
  thinking: ['speaking', 'idle', 'cancelling', 'error'],
  speaking: ['idle', 'cancelling', 'error'],
  cancelling: ['idle'],
  stopping: ['idle'],
  error: ['idle'],
};
export function transitionVoice(snapshot: VoiceSessionSnapshot, next: VoiceState): VoiceSessionSnapshot {
  if (!allowed[snapshot.state].includes(next)) throw Object.assign(new Error('VOICE_ILLEGAL_TRANSITION'), { code: 'VOICE_ILLEGAL_TRANSITION' });
  return { ...snapshot, state: next, error: undefined };
}
