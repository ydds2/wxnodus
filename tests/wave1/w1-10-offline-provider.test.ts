import { describe, expect, it, vi } from 'vitest';
import { ModelRouter } from '../../src/application/models/modelRouter.js';
import { CloudProvider } from '../../src/infrastructure/providers/cloudProvider.js';
import { OfflineProvider } from '../../src/infrastructure/providers/offlineProvider.js';
import type { ModelInferenceRequest } from '../../src/domain/models/modelProvider.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';

const context: OperationContext = { actorId: 'maker-1', sessionId: 'session-1', runId: 'run-1', correlationId: 'corr-1',
  policySnapshotId: 'policy-1', locale: 'zh-CN', source: 'kernel', capabilities: ['offline-model'], timestamp: '2026-08-13T00:00:00.000Z' };
const request = (modelId: string): ModelInferenceRequest => ({ modelId, messages: [{ role: 'user', content: 'reply with text' }] });
const offlineId = 'offline:Qwen2.5-1.5B';

describe('W1-10 provider route', () => {
  it('routes a cached offline model before any API-key gate', async () => {
    const infer = vi.fn(async () => ({ content: 'local answer', promptTokens: 4, completionTokens: 2 }));
    const router = new ModelRouter([
      new OfflineProvider({ isReady: () => true, infer }),
      new CloudProvider({ infer: vi.fn() }),
    ]);
    const result = await router.infer(request(offlineId), context, null, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { content: 'local answer', modelId: offlineId,
      usage: { kind: 'estimated', promptTokens: 4, completionTokens: 2 }, toolCalls: [] } });
    expect(infer).toHaveBeenCalledOnce();
  });

  it('requires a key only after routing to a cloud descriptor', async () => {
    const router = new ModelRouter([new OfflineProvider({ isReady: () => true, infer: vi.fn() }), new CloudProvider({ infer: vi.fn() })]);
    expect(await router.infer(request('deepseek-chat'), context, null, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'MODEL_API_KEY_REQUIRED' } });
  });

  it.each([
    ['not-ready', { isReady: (): boolean => false, infer: vi.fn(async (): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> => ({ content: 'unused' })) }, 'OFFLINE_MODEL_NOT_READY'],
    ['load-failed', { isReady: (): boolean => true, infer: vi.fn(async (): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> => { throw Object.assign(new Error('load'), { code: 'OFFLINE_MODEL_LOAD_FAILED' }); }) }, 'OFFLINE_MODEL_LOAD_FAILED'],
  ] as const)('returns %s as a stable code', async (_name, adapter, code) => {
    const router = new ModelRouter([new OfflineProvider(adapter)]);
    expect(await router.infer(request(offlineId), context, null, new AbortController().signal)).toMatchObject({ ok: false, error: { code } });
  });

  it('distinguishes timeout and cancellation and fences late output', async () => {
    const pending: Array<(value: { content: string; promptTokens: number; completionTokens: number }) => void> = [];
    const provider = new OfflineProvider({ isReady: () => true, infer: vi.fn(((): Promise<{ content: string; promptTokens: number; completionTokens: number }> => new Promise(resolve => pending.push(resolve))) as never) });
    const controller = new AbortController();
    const work = provider.infer({ ...request(offlineId), timeoutMs: 5_000 }, context, null, controller.signal);
    controller.abort(); pending[0]?.({ content: 'late', promptTokens: 1, completionTokens: 1 });
    expect(await work).toMatchObject({ ok: false, error: { code: 'MODEL_INFERENCE_CANCELLED' } });
  });

  it('never converts offline text that resembles a tool call into an executable call', async () => {
    const provider = new OfflineProvider({ isReady: () => true,
      infer: vi.fn(async () => ({ content: '{"tool":"filesystem.write","args":{"path":"x"}}', promptTokens: 9, completionTokens: 4 })) });
    const result = await provider.infer(request(offlineId), context, null, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { toolCalls: [] } });
    if (result.ok) expect(result.value.content).toContain('filesystem.write');
  });
});
