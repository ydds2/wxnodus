// tests/wave3/w3-browser-wiring.test.ts — W3 Browser facade：UrlPolicy 先验 + 生产驱动组装（fail-closed）
import { describe, expect, it } from 'vitest';
import { authorizeBrowserUrl, createProductionBrowserDriver } from '../../src/application/computer/browserWiring.js';
import { BrowserSessionService } from '../../src/application/computer/browserSessionService.js';

const resolve = async (hostname: string) => (hostname === 'allowed.example' ? ['93.184.216.34'] : []);

describe('browser wiring', () => {
  it('authorizes a public URL through the entry policy', async () => {
    const result = await authorizeBrowserUrl({ url: 'https://allowed.example/page', resolve });
    expect(result).toMatchObject({ ok: true, value: { url: 'https://allowed.example/page' } });
  });

  it('rejects loopback and private hosts fail-closed', async () => {
    const localhost = await authorizeBrowserUrl({ url: 'http://127.0.0.1/admin', resolve });
    expect(localhost).toMatchObject({ ok: false, error: { code: 'BROWSER_URL_POLICY_DENIED' } });
    const privateHost = await authorizeBrowserUrl({ url: 'http://192.168.1.1/', resolve });
    expect(privateHost).toMatchObject({ ok: false, error: { code: 'BROWSER_URL_POLICY_DENIED' } });
  });

  it('rejects unknown hosts (DNS fail-closed)', async () => {
    const unknown = await authorizeBrowserUrl({ url: 'https://not-resolvable.example/x', resolve });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'BROWSER_URL_POLICY_DENIED' } });
  });

  it('opens an owned session through the production driver assembly', async () => {
    const driver = createProductionBrowserDriver({
      resolveImpl: resolve,
      launchImpl: async () => ({
        newContext: async () => ({
          route: async () => {},
          newPage: async () => ({ goto: async () => {} }),
          close: async () => {},
        }),
        close: async () => {},
      }),
    });
    const service = new BrowserSessionService(driver);
    const opened = await service.open('session-x');
    expect(opened.ok).toBe(true);
    const closed = await service.close('session-x');
    expect(closed).toMatchObject({ ok: true });
    // owner 校验：重复关闭已不持有的会话 → BROWSER_SESSION_NOT_OWNED
    const again = await service.close('session-x');
    expect(again).toMatchObject({ ok: false, error: { code: 'BROWSER_SESSION_NOT_OWNED' } });
  });

  it('fails closed when connectedAddress is unavailable', async () => {
    const driver = createProductionBrowserDriver({
      resolveImpl: async () => [],
      launchImpl: async () => ({
        newContext: async () => ({
          route: async () => {},
          newPage: async () => ({ goto: async () => {} }),
          close: async () => {},
        }),
        close: async () => {},
      }),
    });
    const service = new BrowserSessionService(driver);
    const opened = await service.open('session-y');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // 目标 URL 授权失败（DNS 无结果 → deny）
    const navigated = await opened.value.navigate('https://ghost.example/');
    expect(navigated.ok).toBe(false);
  });
});
