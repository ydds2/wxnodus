// tests/integration/cdpHarProbe.test.ts — §10-1 完整集成：真实 CDP Network 探针 + 分段/回放校验
// 本机无 chromium 二进制时整组跳过（诚实 skip，绝不伪造 passed）
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { HarCaptureAdapter } from '../../src/infrastructure/browser/harCaptureAdapter.js';
import { CdpHarProbe } from '../../src/infrastructure/browser/cdpHarProbe.js';
import { createPlaywrightCdpPorts } from '../../src/infrastructure/browser/playwrightCdpPorts.js';
import { segmentHarEvents, validateReplay } from '../../src/domain/computer/segmentReplay.js';

let browserAvailable = false;
try { browserAvailable = existsSync(chromium.executablePath()); } catch { browserAvailable = false; }

interface Fixture { server: Server; port: number; url: string }
function startFixtureServer(variant: 'canonical' | 'heldout'): Promise<Fixture> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        const api = variant === 'canonical' ? '/api/order' : '/api/heldout';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body><script>fetch('${api}')</script></body></html>`);
      } else if (pathname === '/api/order' || pathname === '/api/heldout') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

describe.skipIf(!browserAvailable)('CDP 探针（真实无头 Chromium）', () => {
  let fixture: Fixture;
  let outDir: string;
  beforeEach(async () => {
    fixture = await startFixtureServer('canonical');
    outDir = mkdtempSync(join(tmpdir(), 'wxnodus-har-'));
  });
  afterEach(async () => {
    await new Promise(resolve => fixture.server.close(resolve));
    rmSync(outDir, { recursive: true, force: true });
  });

  it('真实 CDP 采集页面加载轨迹并落盘 HAR 1.2（sha256 绑定）', async () => {
    const probe = new CdpHarProbe(createPlaywrightCdpPorts(), new HarCaptureAdapter());
    const captured = await probe.capture('probe-real', fixture.url, { settleMs: 800 });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const urls = captured.value.events.map(event => event.url);
    expect(urls).toContain(`${fixture.url}`);
    expect(urls).toContain(`http://127.0.0.1:${fixture.port}/api/order`);
    expect(captured.value.events.every(event => event.status >= 100 && event.status < 600)).toBe(true);
    const flushed = await new HarCaptureAdapter().flush(captured.value, outDir);
    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;
    const har = JSON.parse(readFileSync(flushed.value.path, 'utf8'));
    expect(har.log.version).toBe('1.2');
    const started = har.log.entries.map((entry: { startedDateTime: string }) => entry.startedDateTime);
    expect([...started].sort()).toEqual(started); // 按 startedAt 升序确定性落盘
    expect(createHash('sha256').update(readFileSync(flushed.value.path)).digest('hex')).toBe(flushed.value.sha256);
  }, 60_000);

  it('两次采集同流程：分段 + 回放校验通过（签名逐段一致）', async () => {
    const probe = new CdpHarProbe(createPlaywrightCdpPorts(), new HarCaptureAdapter());
    const canonical = await probe.capture('probe-canonical', fixture.url, { settleMs: 800 });
    const replay = await probe.capture('probe-replay', fixture.url, { settleMs: 800 });
    expect(canonical.ok && replay.ok).toBe(true);
    if (!canonical.ok || !replay.ok) return;
    const canonicalSegments = segmentHarEvents(probe.toSegmentable(canonical.value));
    const replaySegments = segmentHarEvents(probe.toSegmentable(replay.value));
    expect(canonicalSegments.length).toBeGreaterThanOrEqual(1);
    const verdict = validateReplay(canonicalSegments, replaySegments);
    expect(verdict.ok).toBe(true);
  }, 90_000);

  it('held-out 变体（页面调用不同端点）：回放校验必须识别为 REPLAY_SEGMENT_MISMATCH', async () => {
    const probe = new CdpHarProbe(createPlaywrightCdpPorts(), new HarCaptureAdapter());
    const canonical = await probe.capture('probe-heldout-base', fixture.url, { settleMs: 800 });
    const heldoutFixture = await startFixtureServer('heldout');
    const variant = await probe.capture('probe-heldout-variant', heldoutFixture.url, { settleMs: 800 });
    await new Promise(resolve => heldoutFixture.server.close(resolve));
    expect(canonical.ok && variant.ok).toBe(true);
    if (!canonical.ok || !variant.ok) return;
    const verdict = validateReplay(
      segmentHarEvents(probe.toSegmentable(canonical.value)),
      segmentHarEvents(probe.toSegmentable(variant.value)),
    );
    expect(verdict).toMatchObject({ ok: false, error: { code: 'REPLAY_SEGMENT_MISMATCH' } });
  }, 90_000);
});

describe('分段/回放校验（纯确定性）', () => {
  it('按时间间隙切段：>gapMs 开新段，文档边界开新段', () => {
    const segments = segmentHarEvents([
      { method: 'GET', url: 'http://a/', status: 200, startedAt: '2026-08-13T00:00:01.000Z', isDocument: true },
      { method: 'GET', url: 'http://a/api/order', status: 200, startedAt: '2026-08-13T00:00:02.000Z' },
      { method: 'GET', url: 'http://a/page2', status: 200, startedAt: '2026-08-13T00:00:20.000Z', isDocument: true },
    ]);
    expect(segments.length).toBe(2);
    expect(segments[0].events.map(event => event.url)).toEqual(['http://a/', 'http://a/api/order']);
    expect(segments[1].events.map(event => event.url)).toEqual(['http://a/page2']);
  });

  it('缺段/多段/签名漂移全部识别，不静默通过', () => {
    const segment = (id: string, urls: string[]): import('../../src/domain/computer/segmentReplay.js').HarSegment => ({
      segmentId: id,
      events: urls.map(url => ({ method: 'GET', url, status: 200 })),
    });
    const base = [segment('seg-01', ['http://a/', 'http://a/api']), segment('seg-02', ['http://a/next'])];
    expect(validateReplay(base, [segment('seg-01', ['http://a/', 'http://a/api'])]).ok).toBe(false); // 缺段
    expect(validateReplay(base, [...base, segment('seg-03', ['http://a/extra'])]).ok).toBe(false); // 多段
    expect(validateReplay(base, [segment('seg-01', ['http://a/', 'http://a/evil']), base[1]]).ok).toBe(false); // 签名漂移
    expect(validateReplay(base, [segment('seg-01', ['http://a/', 'http://a/api']), segment('seg-02', ['http://a/next'])]).ok).toBe(true);
  });
});
