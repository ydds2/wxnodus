// src/infrastructure/computer/playwrightBrowserDriver.ts — Playwright 浏览器驱动：每逻辑会话一个 BrowserContext（serviceWorkers 'block'），
// 页面创建/导航之前安装 '**/*' route；每次请求/重定向/弹窗都过 UrlPolicy；能力不足即启动失败（绝不 best-effort 放行）
import type { OperationResult } from '../../protocol/results.js';
import type { UrlPolicy } from './urlPolicy.js';

export interface RouteRequestLike {
  url(): string;
  resourceType(): string;
}
export interface RouteResponseLike { headers(): Record<string, string> }
export interface RouteLike {
  request(): RouteRequestLike;
  continue?(): Promise<void>;
  abort?(reason?: string): Promise<void>;
  fetch?(): Promise<RouteResponseLike>;
}
export interface PageLike { goto(url: string): Promise<unknown> }
export interface ContextLike {
  route?(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(options: { serviceWorkers: 'block' }): Promise<ContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserPorts {
  urlPolicy: UrlPolicy;
  launch(): Promise<BrowserLike>;
  /** 实际连接对端地址；P0-02：必须提供——缺失/不可得即 fail-closed（BROWSER_CONNECTED_ADDRESS_MISSING） */
  connectedAddress(route: RouteLike): Promise<string | null>;
}

export interface BrowserSessionHandle {
  sessionId: string;
  navigate(url: string): Promise<OperationResult<void>>;
  dispose(): Promise<void>;
}

const err = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class PlaywrightBrowserDriver {
  readonly #brand = true;

  constructor(private readonly ports: PlaywrightBrowserPorts) {
    if (typeof ports.connectedAddress !== 'function') {
      throw new TypeError('BROWSER_CONNECTED_ADDRESS_REQUIRED');
    }
  }

  static isGenuine(value: unknown): value is PlaywrightBrowserDriver {
    return typeof value === 'object' && value !== null && #brand in value;
  }

  async openSession(sessionId: string): Promise<OperationResult<BrowserSessionHandle>> {
    let browser: BrowserLike;
    try { browser = await this.ports.launch(); } catch { return err('BROWSER_CONTEXT_ISOLATION_FAILED'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    if (typeof context.route !== 'function') return err('BROWSER_NETWORK_ROUTE_REQUIRED');
    // P0-02：连接地址缺失/不可得/重绑定时记录会话级失败——导航完成后如实返回，绝不静默放行
    let routeFailure: string | null = null;
    // route 必须在任何页面创建/导航之前安装——页面/iframe/弹窗/fetch/worker/下载全部经过同一边界
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      const authorized = await this.ports.urlPolicy.authorize(requestUrl);
      if (!authorized.ok) { routeFailure = authorized.error.code; await route.abort?.('blockedbyclient'); return; }
      let connected: string | null;
      try { connected = await this.ports.connectedAddress(route); } catch { connected = null; }
      if (!connected) { routeFailure = 'BROWSER_CONNECTED_ADDRESS_MISSING'; await route.abort?.('blockedbyclient'); return; }
      const verified = this.ports.urlPolicy.verifyConnectedAddress(authorized.value, connected);
      if (!verified.ok) { routeFailure = verified.error.code; await route.abort?.('blockedbyclient'); return; }
      await route.continue?.();
    });
    const page = await context.newPage();
    const urlPolicy = this.ports.urlPolicy;
    return {
      ok: true,
      value: {
        sessionId,
        async navigate(url) {
          const authorized = await urlPolicy.authorize(url);
          if (!authorized.ok) return authorized;
          routeFailure = null;
          try { await page.goto(url); } catch { return err('BROWSER_CONTEXT_ISOLATION_FAILED'); }
          if (routeFailure) return err(routeFailure);
          return { ok: true, value: undefined };
        },
        async dispose() { await context.close(); await browser.close(); },
      },
    };
  }
}
