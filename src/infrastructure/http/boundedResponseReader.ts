// src/infrastructure/http/boundedResponseReader.ts — P0-08：按真实字节限制的响应读取
// Content-Length 预拒绝（不读任何字节）；无 Content-Length（chunked/压缩后）逐 chunk 按真实字节累计，
// 超限立即 cancel 流并返回 OUTBOUND_HTTP_BODY_TOO_LARGE。绝不静默截断出站响应。
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface BoundedBodyResponse {
  body: ReadableStream<Uint8Array> | null;
  headers: { get(name: string): string | null };
}

export async function readBoundedBody(
  response: BoundedBodyResponse,
  maxBytes: number,
): Promise<OperationResult<{ bytes: Buffer; truncated: false }>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return err(gatewayError('OUTBOUND_HTTP_BODY_LIMIT_INVALID', 'bounded reader limit invalid', 'outboundHttp.body.limitInvalid'));
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    return err(gatewayError('OUTBOUND_HTTP_BODY_TOO_LARGE', `declared content-length ${declared} exceeds ${maxBytes}`, 'outboundHttp.body.tooLarge'));
  }
  if (!response.body) return ok({ bytes: Buffer.alloc(0), truncated: false });
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const bytes = Buffer.from(step.value);
      total += bytes.byteLength;
      if (total > maxBytes) {
        await reader.cancel('OUTBOUND_HTTP_BODY_TOO_LARGE').catch(() => undefined);
        return err(gatewayError('OUTBOUND_HTTP_BODY_TOO_LARGE', `response exceeds ${maxBytes} bytes`, 'outboundHttp.body.tooLarge'));
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return ok({ bytes: Buffer.concat(chunks), truncated: false });
}
