import { describe, expect, it } from 'vitest';
import type { GatewayService, GatewayServiceRequest } from '../../src/application/gatewayService.js';
import { createCliGatewayAdapter } from '../../src/presentation/cli/cliGatewayAdapter.js';
import { createHttpGatewayAdapter } from '../../src/presentation/http/httpGatewayAdapter.js';
import { createHttpSessionIsolation } from '../../src/presentation/http/httpSessionIsolation.js';
import { createHttpTokenStore } from '../../src/presentation/http/httpTokenStore.js';
import { createInProcessGatewayAdapter } from '../../src/presentation/tui/inProcessGatewayAdapter.js';
import { createWireGatewayAdapter } from '../../src/presentation/wire/wireGatewayAdapter.js';
import { gatewayError } from '../../src/protocol/errors.js';
import { err, ok } from '../../src/protocol/results.js';

const NOW = Date.parse('2026-08-13T00:00:00.000Z');
const FUTURE = '2026-08-14T00:00:00.000Z';
const requestLog: GatewayServiceRequest[] = [];
const service: GatewayService = {
  async request(request) {
    requestLog.push(request);
    if (request.method === 'blocked') return err(gatewayError('POLICY_DENIED', '策略拒绝', 'policy.denied'));
    return ok({ method: request.method, sessionId: request.sessionId, source: request.source });
  },
  subscribe: () => () => undefined,
};

function tokenStore() {
  return createHttpTokenStore([{
    id: 'token-a-v1',
    subject: 'client-a',
    secret: 'secret-a-v1',
    notBefore: '2026-08-12T00:00:00.000Z',
    expiresAt: FUTURE,
  }]);
}

function secureConfig(overrides: Record<string, unknown> = {}) {
  return {
    bindHost: '0.0.0.0',
    releaseMode: true,
    hostAllowlist: ['gateway.example.test'],
    originAllowlist: ['https://app.example.test'],
    trustedProxyCidrs: ['10.0.0.0/8'],
    tls: { minVersion: 'TLSv1.2' as const, certificateTrust: 'system' as const },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'prompt.submit',
    params: { sessionId: 'session-a', text: 'hello' },
    headers: {
      authorization: 'Bearer secret-a-v1',
      host: 'gateway.example.test',
      origin: 'https://app.example.test',
    },
    peerAddress: '203.0.113.7',
    transport: { encrypted: true, tlsVersion: 'TLSv1.3', certificateTrusted: true },
    correlationId: 'corr-http-1',
    ...overrides,
  };
}

describe('W1-03 HTTP bootstrap and transport security', () => {
  it('blocks release-mode plaintext on any non-loopback bind before listen', () => {
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig({ tls: undefined }),
      tokens: tokenStore(),
      sessions: createHttpSessionIsolation(),
      now: () => NOW,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('HTTP_PLAINTEXT_NON_LOOPBACK_BLOCKED');
  });

  it.each([
    [{ transport: { encrypted: true, tlsVersion: 'TLSv1.1', certificateTrusted: true } }, 'HTTP_TLS_VERSION_UNSUPPORTED'],
    [{ transport: { encrypted: true, tlsVersion: 'TLSv1.3', certificateTrusted: false } }, 'HTTP_CERTIFICATE_UNTRUSTED'],
    [{ headers: { authorization: 'Bearer secret-a-v1', host: 'evil.test', origin: 'https://app.example.test' } }, 'HTTP_HOST_NOT_ALLOWED'],
    [{ headers: { authorization: 'Bearer secret-a-v1', host: 'gateway.example.test', origin: 'https://evil.test' } }, 'HTTP_ORIGIN_NOT_ALLOWED'],
    [{ headers: { host: 'gateway.example.test', origin: 'https://app.example.test' } }, 'HTTP_TOKEN_MISSING'],
    [{ headers: { authorization: 'Bearer wrong', host: 'gateway.example.test', origin: 'https://app.example.test' } }, 'HTTP_TOKEN_INVALID'],
  ] as const)('rejects request facts with stable code %s', async (override, code) => {
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig(), tokens: tokenStore(), sessions: createHttpSessionIsolation(), now: () => NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const response = await created.value.request(request(override));
    expect(response.result.ok).toBe(false);
    if (!response.result.ok) expect(response.result.error.code).toBe(code);
    expect(response.corsOrigin).not.toBe('*');
  });

  it('rejects forwarded headers from an untrusted peer and accepts them only from a trusted CIDR', async () => {
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig(), tokens: tokenStore(), sessions: createHttpSessionIsolation(), now: () => NOW,
    });
    if (!created.ok) throw new Error(created.error.code);
    const headers = {
      authorization: 'Bearer secret-a-v1',
      host: 'gateway.example.test',
      origin: 'https://app.example.test',
      'x-forwarded-for': '198.51.100.20',
      'x-forwarded-proto': 'https',
    };
    const rejected = await created.value.request(request({ headers, peerAddress: '203.0.113.7' }));
    expect(rejected.result.ok).toBe(false);
    if (!rejected.result.ok) expect(rejected.result.error.code).toBe('HTTP_UNTRUSTED_FORWARDED_HEADER');

    created.value.bindSession('client-a', 'session-a');
    const accepted = await created.value.request(request({ headers, peerAddress: '10.2.3.4' }));
    expect(accepted.result.ok).toBe(true);
    expect(accepted.clientIp).toBe('198.51.100.20');
    expect(accepted.corsOrigin).toBe('https://app.example.test');
  });
});

describe('W1-03 token lifecycle and client isolation', () => {
  it('supports grace rotation, expiry, and immediate revocation', () => {
    const store = tokenStore();
    expect(store.verify('secret-a-v1', NOW).ok).toBe(true);
    store.rotate('client-a', {
      id: 'token-a-v2', subject: 'client-a', secret: 'secret-a-v2',
      notBefore: '2026-08-13T00:00:00.000Z', expiresAt: FUTURE,
    }, '2026-08-13T00:05:00.000Z');
    expect(store.verify('secret-a-v1', NOW + 60_000).ok).toBe(true);
    expect(store.verify('secret-a-v2', NOW + 60_000).ok).toBe(true);
    const expired = store.verify('secret-a-v1', NOW + 6 * 60_000);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe('HTTP_TOKEN_EXPIRED');
    store.revoke('token-a-v2', '2026-08-13T00:07:00.000Z');
    const revoked = store.verify('secret-a-v2', NOW + 8 * 60_000);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe('HTTP_TOKEN_REVOKED');
  });

  it('prevents one token subject from accessing another client session', async () => {
    const store = tokenStore();
    store.rotate('client-b', {
      id: 'token-b-v1', subject: 'client-b', secret: 'secret-b-v1',
      notBefore: '2026-08-12T00:00:00.000Z', expiresAt: FUTURE,
    }, '2026-08-13T00:00:00.000Z');
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig(), tokens: store, sessions: createHttpSessionIsolation(), now: () => NOW,
    });
    if (!created.ok) throw new Error(created.error.code);
    created.value.bindSession('client-a', 'session-a');
    created.value.bindSession('client-b', 'session-b');
    const crossed = await created.value.request(request({
      params: { sessionId: 'session-a', text: 'steal' },
      headers: { authorization: 'Bearer secret-b-v1', host: 'gateway.example.test' },
    }));
    expect(crossed.result.ok).toBe(false);
    if (!crossed.result.ok) expect(crossed.result.error.code).toBe('HTTP_SESSION_CROSS_CLIENT');
  });
});

describe('W1-03 shared adapters and restored session', () => {
  it('delegates CLI/TUI/Wire through one service and keeps a restored session', async () => {
    requestLog.length = 0;
    const cli = createCliGatewayAdapter(service, 'restored-session');
    const tui = createInProcessGatewayAdapter(service, 'restored-session');
    const wire = createWireGatewayAdapter(service, 'restored-session');
    const beforeReady = wire.connectApproval(() => undefined);
    expect(beforeReady.ok).toBe(false);
    if (!beforeReady.ok) expect(beforeReady.error.code).toBe('WIRE_GATEWAY_NOT_READY');
    wire.markReady();
    expect(wire.connectApproval(() => undefined).ok).toBe(true);
    await cli.request('blocked', {});
    await tui.request('blocked', {});
    await wire.request('blocked', {});
    expect(requestLog.map(x => x.sessionId)).toEqual(['restored-session', 'restored-session', 'restored-session']);
    expect(requestLog.map(x => x.source)).toEqual(['cli', 'tui', 'wire']);
  });
});
