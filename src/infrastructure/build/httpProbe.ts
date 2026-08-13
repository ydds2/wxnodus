// src/infrastructure/build/httpProbe.ts — HTTP 探活：真实 GET /，servesRoot 要求 2xx/3xx 且 text/html（否则 BUILD_STATIC_ENTRY_MISSING）
import type { OperationResult } from '../../protocol/results.js';

const fail = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export class HttpProbe {
  constructor(private readonly baseUrl: (port: number) => string = port => `http://127.0.0.1:${port}`) {}

  async probe(port: number, signal: AbortSignal): Promise<OperationResult<{ status: number; servesRoot: boolean }>> {
    try {
      const response = await fetch(`${this.baseUrl(port)}/`, { signal });
      const contentType = response.headers.get('content-type') ?? '';
      const servesRoot = response.status >= 200 && response.status < 400 && contentType.includes('text/html');
      return { ok: true, value: { status: response.status, servesRoot } };
    } catch (error) {
      if (signal.aborted) return fail('BUILD_ABORTED');
      void error;
      return fail('BUILD_PROCESS_NOT_READY');
    }
  }
}
