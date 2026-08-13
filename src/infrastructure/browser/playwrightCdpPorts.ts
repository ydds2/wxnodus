// src/infrastructure/browser/playwrightCdpPorts.ts — CdpHarProbe 的 playwright-core 真实实现：
// chromium.launch(headless) → context.newCDPSession(page) → Network.requestWillBeSent/responseReceived
import { chromium } from 'playwright-core';
import type { CdpHarProbePorts, CdpClientPort } from './cdpHarProbe.js';

export function createPlaywrightCdpPorts(): CdpHarProbePorts {
  return {
    async launch(): Promise<CdpClientPort> {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      return {
        async enableNetwork() { /* launch 时已启用；幂等 */ },
        onRequest(handler) {
          cdp.on('Network.requestWillBeSent', (payload) => {
            const event = payload as unknown as {
              requestId: string;
              request: { method: string; url: string };
              wallTime: number;
              timestamp: number;
            };
            handler({
              requestId: event.requestId,
              method: event.request.method,
              url: event.request.url,
              wallTimeSeconds: event.wallTime,
              monotonicSeconds: event.timestamp,
            });
          });
        },
        onResponse(handler) {
          cdp.on('Network.responseReceived', (payload) => {
            const event = payload as unknown as {
              requestId: string;
              response: { status: number; mimeType?: string };
              timestamp: number;
            };
            handler({
              requestId: event.requestId,
              status: event.response.status,
              mimeType: event.response.mimeType,
              monotonicSeconds: event.timestamp,
            });
          });
        },
        async goto(url: string) {
          await page.goto(url, { waitUntil: 'load' });
        },
        async close() {
          await browser.close();
        },
      };
    },
  };
}
