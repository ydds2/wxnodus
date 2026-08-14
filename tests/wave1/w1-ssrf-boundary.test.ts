// tests/wave1/w1-ssrf-boundary.test.ts — P0-08：出站请求边界（bounded reader + target policy）
// Content-Length 预拒绝；chunked/压缩后按真实字节逐 chunk 限制并取消；DNS 失败 fail-closed；
// 私有目标/非 http(s) scheme 稳定拒绝。legacy safeFetchText 截断语义不受影响（另有回归）。
import { describe, expect, it, vi } from 'vitest';
import { readBoundedBody } from '../../src/infrastructure/http/boundedResponseReader.js';
import { authorizeOutboundUrl } from '../../src/infrastructure/http/outboundTargetPolicy.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string, options: { all?: boolean }) => {
    if (host === 'this-host-does-not-exist-wxnodus.invalid') throw new Error('ENOTFOUND');
    if (host === 'example.com') return options.all ? [{ address: '93.184.216.34' }] : '93.184.216.34';
    if (host === 'rebinding.example.com') return options.all ? [{ address: '93.184.216.34' }, { address: '10.0.0.8' }] : '93.184.216.34';
    throw new Error('ENOTFOUND');
  }),
}));

function streamedResponse(chunks: Uint8Array[], contentLength?: string, contentEncoding?: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = {
    get(name: string) {
      const lower = name.toLowerCase();
      if (lower === 'content-length' && contentLength !== undefined) return contentLength;
      if (lower === 'content-encoding' && contentEncoding !== undefined) return contentEncoding;
      return null;
    },
  };
  return { body, headers };
}

describe('bounded response reader', () => {
  it('reads a small response fully', async () => {
    const response = streamedResponse([Buffer.from('hello')], '5');
    const result = await readBoundedBody(response, 1000);
    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.bytes.toString('utf8')).toBe('hello');
  });

  it('rejects oversized declared Content-Length before reading any bytes', async () => {
    const response = streamedResponse([Buffer.from('x')], '2000000');
    const result = await readBoundedBody(response, 1000);
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_BODY_TOO_LARGE' } });
  });

  it('rejects a chunked body crossing the limit mid-stream and cancels the stream', async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600)];
    const response = streamedResponse(chunks, undefined, 'gzip');
    const result = await readBoundedBody(response, 1000);
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_BODY_TOO_LARGE' } });
  });

  it('enforces the limit on real bytes even when a compressed encoding is declared', async () => {
    const response = streamedResponse([Buffer.alloc(1500)], '1500', 'gzip');
    const result = await readBoundedBody(response, 1000);
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_BODY_TOO_LARGE' } });
  });

  it('treats a missing body as an empty success', async () => {
    const result = await readBoundedBody({ body: null, headers: { get: () => null } }, 1000);
    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
  });
});

describe('outbound target policy', () => {
  it('rejects non-http(s) schemes', async () => {
    expect(await authorizeOutboundUrl('file:///etc/passwd')).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_SCHEME_BLOCKED' } });
    expect(await authorizeOutboundUrl('ftp://example.com/x')).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_SCHEME_BLOCKED' } });
  });

  it('rejects private and loopback literals', async () => {
    for (const url of ['http://127.0.0.1/admin', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/']) {
      expect(await authorizeOutboundUrl(url)).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_TARGET_BLOCKED' } });
    }
  });

  it('fails closed when DNS resolution fails instead of allowing the request to proceed', async () => {
    const result = await authorizeOutboundUrl('http://this-host-does-not-exist-wxnodus.invalid/');
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_DNS_UNRESOLVED' } });
  });

  it('authorizes a public host with its resolved addresses', async () => {
    const result = await authorizeOutboundUrl('https://example.com/');
    expect(result).toMatchObject({ ok: true, value: { targets: ['93.184.216.34'] } });
  });

  it('rejects a host whose resolved address set includes a private address', async () => {
    const result = await authorizeOutboundUrl('http://rebinding.example.com/');
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTBOUND_HTTP_PRIVATE_TARGET' } });
  });
});
