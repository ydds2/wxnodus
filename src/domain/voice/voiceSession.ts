// src/domain/voice/voiceSession.ts — 语音会话/音频引用/保留策略契约：秘密转写只允许 opaque ref 流出，永不暴露明文
export type VoiceRetention = 'ephemeral' | 'session' | 'audit';
export interface AudioRef { id: string; path: string; retention: VoiceRetention }

export const TRANSCRIPT_SCHEME = 'transcript://';
export interface TranscriptRef { readonly ref: `transcript://${string}` }

export const transcriptRefFor = (audioId: string): TranscriptRef => ({ ref: `${TRANSCRIPT_SCHEME}${audioId}` });

/** W3-03：转写产物必须是 opaque ref（transcript://<id>）；明文流出即 VOICE_SECRET_TRANSCRIPT_EXPOSED */
export const isOpaqueTranscriptRef = (value: unknown): value is TranscriptRef =>
  typeof value === 'object' && value !== null &&
  typeof (value as TranscriptRef).ref === 'string' && (value as TranscriptRef).ref.startsWith(TRANSCRIPT_SCHEME);

/** 含秘密内容的音频保留策略收紧为 audit（任何场景不可降级） */
export const resolveRetention = (containsSecret: boolean, requested: VoiceRetention): VoiceRetention =>
  containsSecret ? 'audit' : requested;
