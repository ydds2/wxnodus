// tests/contract/gatewayClient.contract.test.ts — W3-02：sidecar GatewayClient 表面契约（request/on/off 三要素）
// 真实 GatewayClient 必须满足 GatewayPort 适配契约；缺失/伪造表面 → GATEWAY_CONTRACT_MISMATCH
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../src/wxnodus-ui/wxGateway.js';
import {
  assertGatewayClientContract,
  createGatewayPortFromClient,
  toProtocolGatewayEvent,
  type GatewayClientSurface,
} from '../../src/presentation/tui/gatewayClientAdapter.js';

describe('gateway client contract', () => {
  it('accepts the real in-process GatewayClient surface', () => {
    const client = new GatewayClient({} as never);
    expect(assertGatewayClientContract(client)).toMatchObject({ ok: true });
  });

  it('fails closed with GATEWAY_CONTRACT_MISMATCH on a missing surface', () => {
    expect(assertGatewayClientContract(null)).toMatchObject({ ok: false, error: { code: 'GATEWAY_CONTRACT_MISMATCH' } });
    expect(assertGatewayClientContract({ request: 'not-a-function' })).toMatchObject({ ok: false, error: { code: 'GATEWAY_CONTRACT_MISMATCH' } });
    expect(assertGatewayClientContract({ request: () => {}, on: () => {} })).toMatchObject({ ok: false, error: { code: 'GATEWAY_CONTRACT_MISMATCH' } });
  });

  it('maps sidecar events to the protocol envelope deterministically', () => {
    const mapped = toProtocolGatewayEvent({ type: 'run.completed', session_id: 's1', payload: { status: 'failed' } });
    expect(mapped).toMatchObject({
      schemaVersion: 1,
      type: 'run.completed',
      sessionId: 's1',
      source: 'tui',
      retention: 'audit',
      sensitivity: 'internal',
      payload: { status: 'failed' },
    });
    expect(toProtocolGatewayEvent(null)).toBeNull();
    expect(toProtocolGatewayEvent({ type: '' })).toBeNull();
  });

  it('wraps request/subscribe into the protocol GatewayPort', async () => {
    const handlers = new Set<(ev: unknown) => void>();
    const fake: GatewayClientSurface = {
      request: (async (method: string, params?: Record<string, unknown>) => ({ method, params })) as GatewayClientSurface['request'],
      on: vi.fn((_event: 'event', handler: (ev: unknown) => void) => { handlers.add(handler); }),
      off: vi.fn((_event: 'event', handler: (ev: unknown) => void) => { handlers.delete(handler); }),
    };
    const port = createGatewayPortFromClient(fake);

    const response = await port.request('config.get', { key: 'full' });
    expect(response).toMatchObject({ ok: true, value: { method: 'config.get' } });

    const seen: string[] = [];
    const unsubscribe = port.subscribe(event => seen.push(event.type));
    for (const handler of [...handlers]) handler({ type: 'run.started', session_id: 's1', payload: {} });
    expect(seen).toEqual(['run.started']);
    unsubscribe();
    for (const handler of [...handlers]) handler({ type: 'run.started', session_id: 's1', payload: {} });
    expect(seen).toEqual(['run.started']);
  });

  it('maps a throwing RPC to GATEWAY_CONTRACT_MISMATCH instead of letting the UI crash', async () => {
    const fake: GatewayClientSurface = {
      request: (async () => { throw new Error('boom'); }) as GatewayClientSurface['request'],
      on: () => {},
      off: () => {},
    };
    const port = createGatewayPortFromClient(fake);
    await expect(port.request('unknown.method', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'GATEWAY_CONTRACT_MISMATCH' },
    });
  });
});
