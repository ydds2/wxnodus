// tests/integration/browserIsolation.test.ts — W3-06：每会话 BrowserContext 隔离 + 路由先于导航 + DNS rebinding 检测
import { describe, expect, it, vi } from 'vitest';
import { PlaywrightBrowserDriver, type BrowserLike, type RouteLike } from '../../src/infrastructure/computer/playwrightBrowserDriver.js';
import { UrlPolicy } from '../../src/infrastructure/computer/urlPolicy.js';

interface FakeOptions {
  resolver?: (host: string) => Promise<string[]>;
  connectedAddress?: string | null;
  hasRoute?: boolean;
  denyUrls?: string[];
  events?: string[];
}

function makeBrowser(options: FakeOptions) {
  const events = options.events ?? [];
  let installedHandler: ((route: RouteLike) => Promise<void>) | null = null;
  const aborted: string[] = [];
  const pages = [{ goto: vi.fn(async (url: string) => { events.push(`goto:${url}`); }) }];
  const context = {
    route: options.hasRoute === false ? undefined : vi.fn(async (_pattern: string, handler: (route: RouteLike) => Promise<void>) => {
      events.push('route:installed');
      installedHandler = handler;
    }),
    newPage: vi.fn(async () => { events.push('page:created'); return pages[0]; }),
    close: vi.fn(async () => { events.push('context:closed'); }),
  };
  const browser: BrowserLike = {
    newContext: vi.fn(async (opts) => { events.push(`context:${opts.serviceWorkers}`); return context; }),
    close: vi.fn(async () => { events.push('browser:closed'); }),
  };
  const driver = new PlaywrightBrowserDriver({
    urlPolicy: new UrlPolicy({ resolve: options.resolver ?? (async () => ['203.0.113.8']) }),
    launch: async () => browser,
    connectedAddress: async () => options.connectedAddress ?? null,
  });
  return {
    driver, events, aborted, context,
    runRoute: (url: string) => installedHandler!({
      request: () => ({ url: () => url, resourceType: () => 'document' }),
      continue: async () => { events.push(`continue:${url}`); },
      abort: async (reason) => { aborted.push(reason ?? ''); events.push(`abort:${url}`); },
      fetch: async () => ({ headers: () => ({}) }),
    }),
  };
}

describe('browser isolation', () => {
  it('creates one isolated context per session with service workers blocked and route installed before any page', async () => {
    const { driver, events } = makeBrowser({});
    const session = await driver.openSession('s1');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(events[0]).toBe('context:block');
    expect(events.indexOf('route:installed')).toBeLessThan(events.indexOf('page:created'));
    await session.value.dispose();
    expect(events).toContain('context:closed');
  });

  it('denies navigation to policy-blocked URLs and aborts blocked requests in the route', async () => {
    const { driver, aborted, runRoute } = makeBrowser({});
    const session = await driver.openSession('s1');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(await session.value.navigate('http://localhost/admin')).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_URL_POLICY_DENIED' },
    });
    await runRoute('http://169.254.1.1/x');
    expect(aborted).toEqual(['blockedbyclient']);
  });

  it('detects DNS rebinding when the connected address differs from the authorized DNS set', async () => {
    const { driver, aborted, runRoute } = makeBrowser({ resolver: async () => ['203.0.113.8'], connectedAddress: '127.0.0.1' });
    await driver.openSession('s1');
    await runRoute('https://public.example/start');
    expect(aborted).toEqual(['blockedbyclient']);
  });

  it('fails startup with BROWSER_NETWORK_ROUTE_REQUIRED when per-request routing is unavailable', async () => {
    const { driver } = makeBrowser({ hasRoute: false });
    await expect(driver.openSession('s1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BROWSER_NETWORK_ROUTE_REQUIRED' },
    });
  });

  it('rejects non-http schemes and userinfo URLs before any DNS resolution', async () => {
    const resolve = vi.fn(async () => ['203.0.113.8']);
    const policy = new UrlPolicy({ resolve });
    await expect(policy.authorize('file:///etc/passwd')).resolves.toMatchObject({ ok: false, error: { code: 'BROWSER_URL_POLICY_DENIED' } });
    await expect(policy.authorize('https://user:pass@public.example/')).resolves.toMatchObject({ ok: false, error: { code: 'BROWSER_URL_POLICY_DENIED' } });
    expect(resolve).not.toHaveBeenCalled();
  });
});
