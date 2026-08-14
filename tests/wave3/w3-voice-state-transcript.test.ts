// tests/wave3/w3-voice-state-transcript.test.ts — W3 Voice 第 2 步：状态机强制 + 转写产物落盘（opaque ref 唯一出口）
import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionService, type VoiceSessionDeps } from '../../src/application/voice/voiceSessionService.js';

const okProcess = () => ({
  processId: 7, exitCode: 0, signal: null, stdout: '秘密转写内容', stderr: '', timedOut: false, aborted: false,
});
const deps = (overrides: Partial<VoiceSessionDeps> = {}): VoiceSessionDeps => ({
  supervisor: {
    spawn: vi.fn(async () => okProcess()),
    terminateTree: vi.fn(async () => ({ ok: true as const, value: undefined })),
  },
  temp: { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) },
  transcriptStore: {
    save: vi.fn(async () => ({ ok: true as const, value: undefined })),
    load: vi.fn(async () => ({ ok: true as const, value: '秘密转写内容' })),
  },
  sttReady: () => true,
  ...overrides,
});

const ready = async (service: VoiceSessionService) => {
  await service.start('push-to-talk', AbortSignal.timeout(100));
  service.speechDetected();
};

describe('voice state machine + transcript storage', () => {
  it('rejects transcribe from idle (illegal transition, fail-closed)', async () => {
    const service = new VoiceSessionService(deps());
    const result = await service.transcribe({ id: 'a', path: 'x.wav', retention: 'session' }, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'VOICE_ILLEGAL_TRANSITION' } });
  });

  it('persists the transcript through the store and only returns the opaque ref', async () => {
    const d = deps();
    const service = new VoiceSessionService(d);
    await ready(service);
    const result = await service.transcribe({ id: 'audio-9', path: 'x.wav', retention: 'audit' }, AbortSignal.timeout(100));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    // 返回值只含 opaque ref——明文不随返回值流出
    expect(result.value).toEqual({ transcriptRef: { ref: 'transcript://audio-9' } });
    expect(d.transcriptStore.save).toHaveBeenCalledWith('audio-9', '秘密转写内容');
    // 读回也经 ref（store.load 收到的是 opaque ref）
    const read = await service.readTranscript(result.value.transcriptRef);
    expect(read.ok && read.value).toBe('秘密转写内容');
    expect(d.transcriptStore.load).toHaveBeenCalledWith({ ref: 'transcript://audio-9' });
  });

  it('save failure surfaces as the terminal result (no fake success)', async () => {
    const d = deps({
      transcriptStore: {
        save: vi.fn(async () => ({ ok: false as const, error: { code: 'TRANSCRIPT_SAVE_FAILED', message: 'x', messageKey: 'x', retryable: false } })),
        load: vi.fn(),
      },
    });
    const service = new VoiceSessionService(d);
    await ready(service);
    const result = await service.transcribe({ id: 'a2', path: 'x.wav', retention: 'session' }, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'TRANSCRIPT_SAVE_FAILED' } });
  });
});
