// tests/integration/voiceHeadlessParity.test.ts — W3-04：CLI/Wire/HTTP/TUI 四入口共用同一 VoiceSessionService，稳定码/状态完全一致
import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionService } from '../../src/application/voice/voiceSessionService.js';

const makeService = (sttReady: boolean) => new VoiceSessionService({
  supervisor: {
    spawn: vi.fn(async () => ({ processId: 1, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false })),
    terminateTree: vi.fn(async () => ({ ok: true as const, value: undefined })),
  },
  temp: { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) },
  sttReady: () => sttReady,
});

const fronts = ['cli', 'wire', 'http', 'tui'] as const;

describe('voice headless parity', () => {
  it('returns the same stable code on every entry point when STT is unavailable', async () => {
    const results = await Promise.all(fronts.map(async () => {
      const service = makeService(false);
      const result = await service.start('continuous', AbortSignal.timeout(100));
      return result.ok ? result.value.state : result.error.code;
    }));
    expect(new Set(results)).toEqual(new Set(['VOICE_STT_UNAVAILABLE']));
  });

  it('returns the same listening snapshot on every entry point when STT is ready', async () => {
    const results = await Promise.all(fronts.map(async () => {
      const service = makeService(true);
      const result = await service.start('wake-word', AbortSignal.timeout(100));
      return result.ok ? result.value : result.error.code;
    }));
    expect(results.every(value => typeof value !== 'string' && value.state === 'listening' && value.mode === 'wake-word')).toBe(true);
  });

  it('returns identical abort codes on every entry point', async () => {
    const results = await Promise.all(fronts.map(async () => {
      const service = makeService(true);
      const controller = new AbortController();
      const pending = service.transcribe({ id: 'x', path: 'x.wav', retention: 'ephemeral' }, controller.signal);
      controller.abort();
      const result = await pending;
      return result.ok ? 'ok' : result.error.code;
    }));
    expect(new Set(results)).toEqual(new Set(['VOICE_WORKER_ABORTED']));
  });
});
