// src/application/computer/browserSessionService.ts — P0-02：浏览器会话服务权威
// 会话句柄只能由本服务 open 后持有（owner 校验）；每 session 独立 BrowserContext；
// driver 的 URL 策略/连接地址验证 fail-closed（connectedAddress 缺失即 BROWSER_CONNECTED_ADDRESS_MISSING）。
import type { OperationResult } from '../../protocol/results.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { PlaywrightBrowserDriver, type BrowserSessionHandle } from '../../infrastructure/computer/playwrightBrowserDriver.js';

export class BrowserSessionService {
  readonly #brand = true;
  readonly #handles = new Map<string, BrowserSessionHandle>();

  constructor(private readonly driver: PlaywrightBrowserDriver) {
    if (!PlaywrightBrowserDriver.isGenuine(driver)) {
      throw new TypeError('BROWSER_DRIVER_UNTRUSTED');
    }
  }

  static isGenuine(value: unknown): value is BrowserSessionService {
    return typeof value === 'object' && value !== null && #brand in value;
  }

  async open(sessionId: string): Promise<OperationResult<BrowserSessionHandle>> {
    const opened = await this.driver.openSession(sessionId);
    if (opened.ok) this.#handles.set(sessionId, opened.value);
    return opened;
  }

  get(sessionId: string): OperationResult<BrowserSessionHandle> {
    const handle = this.#handles.get(sessionId);
    return handle ? ok(handle) : err(gatewayError('BROWSER_SESSION_NOT_OWNED', 'browser session not owned by this service', 'browser.session.notOwned'));
  }

  async close(sessionId: string): Promise<OperationResult<void>> {
    const handle = this.#handles.get(sessionId);
    if (!handle) return err(gatewayError('BROWSER_SESSION_NOT_OWNED', 'browser session not owned by this service', 'browser.session.notOwned'));
    this.#handles.delete(sessionId);
    await handle.dispose().catch(() => undefined);
    return ok(undefined);
  }

  async closeAll(): Promise<void> {
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    for (const handle of handles) await handle.dispose().catch(() => undefined);
  }
}
