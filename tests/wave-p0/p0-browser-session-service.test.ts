// tests/wave-p0/p0-browser-session-service.test.ts — P0-02：浏览器会话服务权威
// 每 session 独立 BrowserContext；close 校验 owner；connectedAddress 缺失必须 fail-closed；
// URL 策略拒绝与 DNS 重绑定同样 fail-closed。fake ports 即可验证 wiring（无需真实浏览器）。
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightBrowserDriver, type BrowserLike, type PlaywrightBrowserPorts, type RouteLike } from '../../src/infrastructure/computer/playwrightBrowserDriver.js';
import { BrowserSessionService } from '../../src/application/computer/browserSessionService.js';
import { UrlPolicy } from '../../src/infrastructure/computer/urlPolicy.js';

interface FakeSession { invokeRoute(url: string): Promise<void>; closed: () => boolean }

function makePorts(connectedAddress: string | null) {
  const routeHandlers: Array<(route: RouteLike) => Promise<void>> = [];
  const closedContexts: boolean[] = [];
  const launched: BrowserLike[] = [];
  const policy = new UrlPolicy({
    resolve: async hostname => hostname === 'allowed.example' ? ['93.184.216.34'] : [],
  });
  const ports: PlaywrightBrowserPorts = {
    urlPolicy: policy,
    launch: async () => {
      const index = closedContexts.length;
      closedContexts.push(false);
      const browser: BrowserLike = {
        newContext: async () => ({
          route: async (_pattern, handler) => { routeHandlers[index] = handler; },
          newPage: async () => ({ goto: async () => { await routeHandlers[index]?.({ request: () => ({ url: () => 'https://allowed.example/child.js', resourceType: () => 'script' }), abort: async () => { } }); } }),
          close: async () => { closedContexts[index] = true; },
        }),
        close: async () => { closedContexts[index] = true; },
      };
      launched.push(browser);
      return browser;
    },
    connectedAddress: async () => connectedAddress,
  };
  return { ports, launched, closedContexts, routeHandlers };
}

describe('browser session service', () => {
  it('opens an isolated context per session and closes only owned sessions', async () => {
    const { ports, launched } = makePorts('93.184.216.34');
    const service = new BrowserSessionService(new PlaywrightBrowserDriver(ports));
    const first = await service.open('session-a');
    const second = await service.open('session-b');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('open failed');
    expect(launched).toHaveLength(2);

    const unowned = await service.close('session-c');
    expect(unowned).toMatchObject({ ok: false, error: { code: 'BROWSER_SESSION_NOT_OWNED' } });

    expect(await service.close('session-a')).toMatchObject({ ok: true });
    expect(await service.close('session-a')).toMatchObject({ ok: false, error: { code: 'BROWSER_SESSION_NOT_OWNED' } });
    expect(await service.close('session-b')).toMatchObject({ ok: true });
  });

  it('navigates only to policy-authorized urls and verifies the connected address', async () => {
    const { ports } = makePorts('93.184.216.34');
    const service = new BrowserSessionService(new PlaywrightBrowserDriver(ports));
    const opened = await service.open('session-a');
    if (!opened.ok) throw new Error(opened.error.code);

    expect(await opened.value.navigate('https://blocked.example/')).toMatchObject({
      ok: false, error: { code: 'BROWSER_URL_POLICY_DENIED' },
    });
    expect(await opened.value.navigate('https://allowed.example/page')).toMatchObject({ ok: true });
    await service.close('session-a');
  });

  it('fails closed when the connected address cannot be determined', async () => {
    const { ports } = makePorts(null);
    const service = new BrowserSessionService(new PlaywrightBrowserDriver(ports));
    const opened = await service.open('session-a');
    if (!opened.ok) throw new Error(opened.error.code);

    expect(await opened.value.navigate('https://allowed.example/page')).toMatchObject({
      ok: false, error: { code: 'BROWSER_CONNECTED_ADDRESS_MISSING' },
    });
    await service.close('session-a');
  });

  it('rejects the session service itself when the driver is not genuine', () => {
    expect(BrowserSessionService.isGenuine({} as never)).toBe(false);
    const { ports } = makePorts('93.184.216.34');
    expect(BrowserSessionService.isGenuine(new BrowserSessionService(new PlaywrightBrowserDriver(ports)))).toBe(true);
  });
});

void vi;
