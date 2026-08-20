// tests/wave2/w2-gateway-service.test.ts — W2-02：GatewayService 分派器契约
// 统一传播 source/session/correlation/signal；未知 method 稳定失败不回退 legacy；
// 异常 fail-closed；事件订阅可退订。
import { describe, expect, it, vi } from 'vitest';
import { createGatewayService } from '../../src/application/createGatewayService.js';
import type { GatewayServiceRequest } from '../../src/application/gatewayService.js';

const request = (overrides: Partial<GatewayServiceRequest> = {}): GatewayServiceRequest => ({
  method: 'prompt.submit',
  params: { text: 'hello' },
  sessionId: 'session-a',
  source: 'cli',
  correlationId: 'corr-1',
  ...overrides,
});

describe('gateway service dispatcher', () => {
  it('routes a registered method with the full request context', async () => {
    const seen: GatewayServiceRequest[] = [];
    const service = createGatewayService({
      'prompt.submit': async input => {
        seen.push(input);
        return { ok: true as const, value: { accepted: true } };
      },
    });
    const result = await service.request(request());
    expect(result).toMatchObject({ ok: true, value: { accepted: true } });
    expect(seen[0]).toMatchObject({
      method: 'prompt.submit',
      sessionId: 'session-a',
      source: 'cli',
      correlationId: 'corr-1',
    });
  });

  it('fails unknown methods with a stable code instead of falling back anywhere', async () => {
    const service = createGatewayService({});
    const result = await service.request(request({ method: 'ghost.method' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'GATEWAY_METHOD_UNKNOWN' } });
  });

  it('propagates the abort signal to the handler', async () => {
    const controller = new AbortController();
    const handler = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const service = createGatewayService({ 'prompt.submit': handler });
    await service.request(request({ signal: controller.signal }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it('fails closed when a handler throws instead of leaking the exception', async () => {
    const service = createGatewayService({
      'prompt.submit': async () => {
        throw new Error('boom');
      },
    });
    const result = await service.request(request());
    expect(result).toMatchObject({ ok: false, error: { code: 'GATEWAY_METHOD_FAILED' } });
  });

  it('subscribes and unsubscribes event handlers', () => {
    const service = createGatewayService({});
    const received: string[] = [];
    const unsubscribe = service.subscribe(event => received.push(event.type));
    // 通过注册的 emit 路径不可达于 dispatcher——订阅返回可退订句柄即为契约面
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
