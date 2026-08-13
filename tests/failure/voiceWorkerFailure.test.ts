// tests/failure/voiceWorkerFailure.test.ts — W3-04 Step 1：取消/不可用失败路径（计划原文）
import { expect, it, vi } from 'vitest';
import { VoiceSessionService } from '../../src/application/voice/voiceSessionService.js';

it('keeps the event loop responsive and confirms process-tree termination on abort', async () => {
  let heartbeat = 0;
  const interval = setInterval(() => { heartbeat += 1; }, 5);
  const terminateTree = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const supervisor = {
    spawn: vi.fn(async (_exe: string, _args: string[], _options: unknown, signal: AbortSignal) =>
      new Promise<{ processId: number; exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }>(
        resolve => signal.addEventListener('abort', () => resolve({
          processId: 41, exitCode: null, signal: 'ABORT', stdout: '', stderr: '', timedOut: false, aborted: true,
        }), { once: true }))),
    terminateTree,
  };
  const temp = { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) };
  const service = new VoiceSessionService({ supervisor, temp, sttReady: () => true });
  const controller = new AbortController();
  const pending = service.transcribe({ id: 'audio-1', path: 'audio.wav', retention: 'ephemeral' }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  const result = await pending;
  clearInterval(interval);

  expect(heartbeat).toBeGreaterThan(1);
  expect(result).toMatchObject({ ok: false, error: { code: 'VOICE_WORKER_ABORTED' } });
  expect(terminateTree).toHaveBeenCalledWith(41, 5_000);
  expect(temp.remove).toHaveBeenCalledWith('audio.wav');
  expect(service.snapshot().state).toBe('idle');
});

it('does not enter listening when STT capability is unavailable', async () => {
  const service = new VoiceSessionService({
    supervisor: { spawn: vi.fn(), terminateTree: vi.fn() },
    temp: { remove: vi.fn() },
    sttReady: () => false,
  });
  await expect(service.start('push-to-talk', AbortSignal.timeout(100))).resolves.toMatchObject({
    ok: false,
    error: { code: 'VOICE_STT_UNAVAILABLE' },
  });
  expect(service.snapshot().state).toBe('idle');
});
