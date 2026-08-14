// src/application/computer/browserWiring.ts — W3 Browser facade：生产浏览器驱动组装
// UrlPolicy（真实 dns 解析 + 私网/loopback/link-local/多播拒绝）→ PlaywrightBrowserDriver（每 session 独立
// context；route 层 URL 授权；connectedAddress = 授权 DNS 集合比对——rebinding 防线的解析层验证）。
// 无图形/浏览器环境时 launch 失败诚实返回（BROWSER_LAUNCH_FAILED），绝不假装可用。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { OperationResult } from '../../protocol/results.js';
import { PlaywrightBrowserDriver, type BrowserLike, type PlaywrightBrowserPorts, type RouteLike } from '../../infrastructure/computer/playwrightBrowserDriver.js';
import { UrlPolicy } from '../../infrastructure/computer/urlPolicy.js';

export interface BrowserWiringInput {
  channel?: 'msedge' | 'chrome';
  headless?: boolean;
  /** 注入 launch（测试用）；缺省用 playwright-core 真实启动 */
  launchImpl?: () => Promise<BrowserLike>;
  /** 注入 dns 解析（测试用）；缺省用 node:dns/promises.lookup */
  resolveImpl?: (hostname: string) => Promise<string[]>;
}

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export function createProductionBrowserDriver(input: BrowserWiringInput = {}): PlaywrightBrowserDriver {
  const resolve = input.resolveImpl ?? (async (hostname: string) => {
    if (isIP(hostname)) return [hostname];
    const results = await lookup(hostname, { all: true });
    return results.map(r => r.address);
  });

  const ports: PlaywrightBrowserPorts = {
    urlPolicy: new UrlPolicy({ resolve }),
    launch: input.launchImpl ?? (async () => {
      try {
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({
          channel: input.channel ?? 'msedge',
          headless: input.headless ?? false,
        });
        return {
          newContext: async () => {
            const context = await browser.newContext();
            return {
              route: async (pattern, handler) => {
                await context.route(pattern, route => handler({
                  request: () => ({
                    url: () => route.request().url(),
                    resourceType: () => route.request().resourceType(),
                  }),
                  abort: async () => { await route.abort(); },
                }));
              },
              newPage: async () => {
                const page = await context.newPage();
                return {
                  goto: async (url: string) => {
                    await page.goto(url);
                  },
                };
              },
              close: async () => {
                await context.close();
              },
            };
          },
          close: async () => {
            await browser.close();
          },
        } satisfies BrowserLike;
      } catch (cause) {
        throw new Error(`BROWSER_LAUNCH_FAILED: ${String((cause as Error)?.message ?? cause)}`);
      }
    }),
    connectedAddress: async (route: RouteLike) => {
      // 解析层验证：目标 hostname 的当前 DNS 解析与授权集合比对（rebinding 防线）；
      // 真实 socket 地址由浏览器栈管理——此处返回授权首地址供 driver 比对
      try {
        const url = new URL(route.request().url());
        const addresses = await resolve(url.hostname);
        return addresses[0] ?? null;
      } catch {
        return null;
      }
    },
  };

  return new PlaywrightBrowserDriver(ports);
}

/** 生产入口的 URL 授权（handler 层先验 + driver 内逐跳复验——双重防线） */
export async function authorizeBrowserUrl(input: {
  url: string;
  resolve?: (hostname: string) => Promise<string[]>;
}): Promise<OperationResult<{ url: string }>> {
  try {
    const policy = new UrlPolicy({ resolve: input.resolve ?? (async (hostname: string) => {
      if (isIP(hostname)) return [hostname];
      const results = await lookup(hostname, { all: true });
      return results.map(r => r.address);
    }) });
    const authorized = await policy.authorize(input.url);
    if (!authorized.ok) return authorized;
    return { ok: true, value: { url: authorized.value.url } };
  } catch (cause) {
    return fail('BROWSER_URL_AUTHORIZE_FAILED', { cause: String(cause) });
  }
}
