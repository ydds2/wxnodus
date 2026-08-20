// tests/unit/voice/voice-domain.contract.test.ts — W3-03：状态机/保留策略/opaque 转写契约
import { describe, expect, it } from 'vitest';
import { transitionVoice, type VoiceSessionSnapshot } from '../../../src/domain/voice/voiceState.js';
import {
  isOpaqueTranscriptRef,
  resolveRetention,
  transcriptRefFor,
} from '../../../src/domain/voice/voiceSession.js';

const idle = (): VoiceSessionSnapshot => ({ id: 's1', state: 'idle', mode: 'push-to-talk', selectedDeviceId: null });

describe('voice domain contracts', () => {
  it('allows the legal pipeline and rejects illegal transitions with VOICE_ILLEGAL_TRANSITION', () => {
    let s = idle();
    s = transitionVoice(s, 'listening');
    s = transitionVoice(s, 'speech_detected');
    s = transitionVoice(s, 'transcribing');
    s = transitionVoice(s, 'thinking');
    s = transitionVoice(s, 'speaking');
    expect(transitionVoice(s, 'idle').state).toBe('idle');
    expect(() => transitionVoice(idle(), 'speaking')).toThrowError(
      expect.objectContaining({ code: 'VOICE_ILLEGAL_TRANSITION' }),
    );
    // error → idle 是唯一恢复路径
    const errored = transitionVoice(transitionVoice(idle(), 'listening'), 'error');
    expect(transitionVoice(errored, 'idle').state).toBe('idle');
    // 非法迁移不改动原快照（不可变）
    const before = idle();
    expect(() => transitionVoice(before, 'speaking')).toThrow();
    expect(before.state).toBe('idle');
  });

  it('tightens secret audio retention to audit and never downgrades', () => {
    expect(resolveRetention(true, 'session')).toBe('audit');
    expect(resolveRetention(false, 'session')).toBe('session');
    expect(resolveRetention(true, 'ephemeral')).toBe('audit');
  });

  it('exposes transcripts only as opaque refs and never as plain text', () => {
    expect(transcriptRefFor('audio-1')).toEqual({ ref: 'transcript://audio-1' });
    expect(isOpaqueTranscriptRef(transcriptRefFor('audio-1'))).toBe(true);
    expect(isOpaqueTranscriptRef('hello world')).toBe(false);
    expect(isOpaqueTranscriptRef({ ref: 'file://x' })).toBe(false);
    expect(isOpaqueTranscriptRef(null)).toBe(false);
  });
});
