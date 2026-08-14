// tests/wave5/w5-har-privacy.test.ts — W5-02 HAR 隐私契约（RED → 实现后全绿）
// 预存储脱敏：URL userinfo 与敏感 query（token/access_token/refresh_token/api_key/client_secret/signature/code…）
// 在事件进入内存前即删除；无法安全 parse 则拒绝。配额：event/URL/session/file/directory 逐维限制，
// 超限写 complete:false + reason + counts + policy digest。retention 只删 owned 文件。原子写（tmp+fsync+rename）。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarCaptureAdapter, type HarSession } from '../../src/infrastructure/browser/harCaptureAdapter.js';
import { redactHarUrl } from '../../src/infrastructure/browser/redactionPolicy.js';
import { createHarQuotaPolicy } from '../../src/infrastructure/browser/harQuotaPolicy.js';
import { applyHarRetention } from '../../src/infrastructure/browser/harRetention.js';
import { CdpHarProbe, type CdpHarProbePorts, type CdpClientPort, type CdpNetworkRequestEvent, type CdpNetworkResponseEvent } from '../../src/infrastructure/browser/cdpHarProbe.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SECRET_URL = 'https://user:pass@example.com/api/order?token=sk-secret-1&access_token=AT&refresh_token=RT&api_key=AK&client_secret=CS&signature=SIG&code=CODE&page=2';

describe('W5-02 预存储脱敏（redactionPolicy）', () => {
  it('URL userinfo + 敏感 query 全删除；非敏感参数保留；secret 不出现在输出', () => {
    const result = redactHarUrl(SECRET_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).not.toContain('user:pass@');
    for (const secret of ['sk-secret-1', 'AT', 'RT', 'AK', 'CS', 'SIG', 'CODE']) {
      expect(result.value.url).not.toContain(secret);
    }
    expect(result.value.url).toContain('page=2'); // 非敏感参数保留
    expect(result.value.redactedKeys.sort()).toEqual(['access_token', 'api_key', 'client_secret', 'code', 'refresh_token', 'signature', 'token']);
    expect(result.value.url).toContain('[REDACTED]');
  });

  it('敏感键大小写不敏感（API_KEY 同样脱敏）；无法安全 parse → 拒绝', () => {
    const upper = redactHarUrl('https://x.com/a?API_KEY=uppercase');
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.value.url).not.toContain('uppercase');
    expect(redactHarUrl('not a url at all')).toMatchObject({ ok: false });
    expect(redactHarUrl('file:///etc/passwd')).toMatchObject({ ok: false });
    expect(redactHarUrl('https://exa mple.com/x')).toMatchObject({ ok: false });
  });

  it('adapter.recordEvent 只在内存存脱敏 URL（secret 绝不进入 session.events）', () => {
    const adapter = new HarCaptureAdapter();
    const session = adapter.openSession('s1');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const recorded = adapter.recordEvent(session.value, { method: 'GET', url: SECRET_URL, status: 200, startedAt: '2026-08-15T00:00:00.000Z', durationMs: 1 });
    expect(recorded).toMatchObject({ ok: true });
    const stored = JSON.stringify(session.value.events);
    expect(stored).not.toContain('sk-secret-1');
    expect(stored).not.toContain('user:pass@');
    expect(stored).toContain('[REDACTED]');
  });
});

describe('W5-02 配额（harQuotaPolicy + adapter 强制）', () => {
  const ev = (url: string): Parameters<HarCaptureAdapter['recordEvent']>[1] => ({ method: 'GET', url, status: 200, startedAt: '2026-08-15T00:00:00.000Z', durationMs: 1 });

  it('事件数超限 → HAR_QUOTA_EVENTS_EXCEEDED；URL 超长 → HAR_QUOTA_URL_TOO_LONG', () => {
    const adapter = new HarCaptureAdapter({ quota: { maxEventsPerSession: 2, maxUrlLength: 32 } });
    const session = adapter.openSession('s2');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(adapter.recordEvent(session.value, ev('https://a.example/x'))).toMatchObject({ ok: true });
    expect(adapter.recordEvent(session.value, ev('https://b.example/y'))).toMatchObject({ ok: true });
    expect(adapter.recordEvent(session.value, ev('https://c.example/z'))).toMatchObject({ ok: false, error: { code: 'HAR_QUOTA_EVENTS_EXCEEDED' } });
    const longUrl = `https://d.example/${'x'.repeat(64)}`;
    expect(adapter.recordEvent(session.value, ev(longUrl))).toMatchObject({ ok: false, error: { code: 'HAR_QUOTA_URL_TOO_LONG' } });
  });

  it('flush 正常：complete:true + counts + policyDigest + sha256 绑定', async () => {
    const adapter = new HarCaptureAdapter();
    const session = adapter.openSession('s3');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(adapter.recordEvent(session.value, ev(SECRET_URL))).toMatchObject({ ok: true });
    const dir = tmp('w5-har-');
    const flushed = await adapter.flush(session.value, dir);
    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;
    expect(flushed.value).toMatchObject({ complete: true, counts: { events: 1, redactedParams: 7 } });
    expect(flushed.value.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    const content = readFileSync(flushed.value.path, 'utf8');
    expect(content).not.toContain('sk-secret-1');
  });

  it('文件字节超限 → 仍落盘但 complete:false + reason；目录配额超限 → complete:false', async () => {
    const adapter = new HarCaptureAdapter({ quota: { maxFileBytes: 256, maxFilesPerDirectory: 1 } });
    const session = adapter.openSession('s4');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(adapter.recordEvent(session.value, { ...ev('https://a.example/x'), url: `https://a.example/${'y'.repeat(64)}` })).toMatchObject({ ok: true });
    const dir = tmp('w5-har-file-');
    const flushed = await adapter.flush(session.value, dir);
    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;
    expect(flushed.value.complete).toBe(false);
    expect(flushed.value.reason).toBe('HAR_QUOTA_FILE_TOO_LARGE');
    expect(existsSync(flushed.value.path)).toBe(true); // 仍落盘（诚实标记不完整）
    // 目录文件数超限
    const session2 = adapter.openSession('s5');
    if (!session2.ok) return;
    expect(adapter.recordEvent(session2.value, ev('https://b.example/x'))).toMatchObject({ ok: true });
    const flushed2 = await adapter.flush(session2.value, dir);
    expect(flushed2.ok).toBe(true);
    if (!flushed2.ok) return;
    expect(flushed2.value.complete).toBe(false);
    expect(flushed2.value.reason).toBe('HAR_QUOTA_DIRECTORY_EXCEEDED');
  });
});

describe('W5-02 retention（只删 owned 文件）', () => {
  it('只删 session-*.har；外来文件与子目录不动；超龄优先删除', () => {
    const dir = tmp('w5-har-ret-');
    writeFileSync(join(dir, 'README.txt'), 'foreign');
    writeFileSync(join(dir, 'notes.har'), 'not-owned-pattern'); // 不匹配 owned 模式
    writeFileSync(join(dir, 'session-old.har'), 'old');
    writeFileSync(join(dir, 'session-new.har'), 'new');
    const oldTime = Date.now() - 10 * 60_000;
    utimesSync(join(dir, 'session-old.har'), new Date(oldTime), new Date(oldTime));
    const result = applyHarRetention(dir, { maxFiles: 1, maxAgeMs: 5 * 60_000, now: () => Date.now() });
    expect(result).toMatchObject({ ok: true });
    expect(readdirSync(dir).sort()).toEqual(['README.txt', 'notes.har', 'session-new.har']); // old.har 被删
  });
});

describe('W5-02 CDP 探针（redaction 在 pending 之前 + abort 清理）', () => {
  class FakeClient implements CdpClientPort {
    private requestHandler?: (event: CdpNetworkRequestEvent) => void;
    private responseHandler?: (event: CdpNetworkResponseEvent) => void;
    async enableNetwork() {}
    onRequest(handler: (event: CdpNetworkRequestEvent) => void) { this.requestHandler = handler; }
    onResponse(handler: (event: CdpNetworkResponseEvent) => void) { this.responseHandler = handler; }
    async goto(_url: string) {
      // 导航期间发生两个请求：一个带 secret、一个无法 parse
      this.requestHandler?.({ requestId: 'r1', method: 'GET', url: SECRET_URL, wallTimeSeconds: Date.now() / 1000, monotonicSeconds: 0 });
      this.responseHandler?.({ requestId: 'r1', status: 200, mimeType: 'text/html', monotonicSeconds: 0.01 });
      this.requestHandler?.({ requestId: 'r2', method: 'GET', url: 'not a url', wallTimeSeconds: Date.now() / 1000, monotonicSeconds: 0.02 });
    }
    async close() {}
  }

  it('采集结果不含 secret；不可 parse 事件被丢弃不崩溃', async () => {
    const adapter = new HarCaptureAdapter();
    const probe = new CdpHarProbe({ launch: async () => new FakeClient() }, adapter);
    const result = await probe.capture('probe-1', 'https://example.com/page', { settleMs: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value.events)).not.toContain('sk-secret-1');
    expect(JSON.stringify(result.value.events)).toContain('[REDACTED]');
  });

  it('abort 信号 → CDP_PROBE_ABORTED（pending 经 finally 清理，无泄漏崩溃）', async () => {
    const adapter = new HarCaptureAdapter();
    const controller = new AbortController();
    const probe = new CdpHarProbe({ launch: async () => new FakeClient() }, adapter);
    setTimeout(() => controller.abort(), 5);
    const result = await probe.capture('probe-2', 'https://example.com/page', { settleMs: 60, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: 'CDP_PROBE_ABORTED' } });
  });
});
