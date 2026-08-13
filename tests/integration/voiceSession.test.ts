// tests/integration/voiceSession.test.ts — W3-04：语音会话服务全路径（成功/超时/崩溃/保留策略）
import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionService } from '../../src/application/voice/voiceSessionService.js';

const okProcess = (overrides: Partial<{ exitCode: number | null; timedOut: boolean; aborted: boolean }> = {}) => ({
  processId: 7, exitCode: 0, signal: null, stdout: '你好世界', stderr: '', timedOut: false, aborted: false, ...overrides,
});

describe('VoiceSessionService', () => {
  it('transcribes successfully and returns an opaque transcript ref', async () => {
    const spawn = vi.fn(async () => okProcess());
    const temp = { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) };
    const service = new VoiceSessionService({ supervisor: { spawn, terminateTree: vi.fn() }, temp, sttReady: () => true });
    const result = await service.transcribe({ id: 'audio-1', path: 'a.wav', retention: 'session' }, AbortSignal.timeout(1_000));
    expect(result).toMatchObject({ ok: true, value: { transcriptRef: { ref: 'transcript://audio-1' } } });
    // session 保留：临时文件不清理
    expect(temp.remove).not.toHaveBeenCalled();
    expect(service.snapshot().state).toBe('idle');
  });

  it('cleans up ephemeral audio after transcribe and maps timeout/crash to stable codes', async () => {
    const temp = { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) };
    const timedOut = new VoiceSessionService({ supervisor: { spawn: vi.fn(async () => okProcess({ timedOut: true })), terminateTree: vi.fn() }, temp, sttReady: () => true });
    expect(await timedOut.transcribe({ id: 'a2', path: 'b.wav', retention: 'ephemeral' }, AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, error: { code: 'VOICE_WORKER_TIMEOUT' } });
    expect(temp.remove).toHaveBeenCalledWith('b.wav');

    const crashed = new VoiceSessionService({ supervisor: { spawn: vi.fn(async () => okProcess({ exitCode: 3 })), terminateTree: vi.fn() }, temp, sttReady: () => true });
    expect(await crashed.transcribe({ id: 'a3', path: 'c.wav', retention: 'audit' }, AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, error: { code: 'VOICE_WORKER_CRASHED' } });
    // audit 保留：不清理
    expect(temp.remove).not.toHaveBeenCalledWith('c.wav');
  });

  it('reports VOICE_PROCESS_TREE_STILL_RUNNING when termination fails on abort', async () => {
    const supervisor = {
      spawn: vi.fn(async (_exe: string, _args: string[], _options: unknown, signal: AbortSignal) =>
        new Promise<{ processId: number; exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }>(
          resolve => signal.addEventListener('abort', () => resolve({ ...okProcess(), aborted: true }), { once: true }))),
      terminateTree: vi.fn(async () => ({ ok: false as const, error: { code: 'VOICE_PROCESS_TREE_STILL_RUNNING', message: 'x', messageKey: 'x', retryable: false } })),
    };
    const service = new VoiceSessionService({ supervisor, temp: { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) }, sttReady: () => true });
    const controller = new AbortController();
    const pending = service.transcribe({ id: 'a4', path: 'd.wav', retention: 'ephemeral' }, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'VOICE_PROCESS_TREE_STILL_RUNNING' } });
  });
});
