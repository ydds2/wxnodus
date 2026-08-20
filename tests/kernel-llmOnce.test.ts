import { afterEach, describe, expect, it, vi } from 'vitest';
import { callModelOnce } from '../src/kernel/llmOnce.js';

describe('callModelOnce cancellation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('combines the caller signal with the request timeout', async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(resolve => { resolveFetch = resolve; });
    }));

    const controller = new AbortController();
    const work = callModelOnce({
      baseURL: 'https://example.invalid',
      model: 'test-model',
      key: 'test-key',
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    resolveFetch(new Response(JSON.stringify({ choices: [{ message: { content: 'late' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(work).resolves.toMatchObject({ ok: false });
  });
});
