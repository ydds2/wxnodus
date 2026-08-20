// tests/forge-compliance-release.contract.test.ts — §10 剩余四项的最小可验证合同：
// CDP/HAR 采集适配 / exemplar 池 / 市场签名 / 平台授权槽位 / 安装器 manifest
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarCaptureAdapter } from '../src/infrastructure/browser/harCaptureAdapter.js';
import { ExemplarPool } from '../src/application/forge/exemplarPool.js';
import { createSigningKeypair, payloadDigestOf, signMarketItem, verifyMarketItem } from '../src/application/forge/marketSigning.js';
import { PlatformAuthRegistry } from '../src/application/compliance/platformAuthRegistry.js';
import { buildInstallerManifest, sanitizeAppName } from '../src/application/release/installerManifest.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxnodus-forge-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('CDP/HAR 采集适配（最小版）', () => {
  it('records network events and flushes a deterministic HAR 1.2 file with sha256 binding', async () => {
    const adapter = new HarCaptureAdapter();
    const opened = adapter.openSession('sess-a');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value;
    expect(adapter.recordEvent(session, { method: 'POST', url: 'https://example.com/api/order', status: 200, startedAt: '2026-08-13T00:00:02.000Z', durationMs: 120, mimeType: 'application/json', size: 42 })).toMatchObject({ ok: true });
    expect(adapter.recordEvent(session, { method: 'GET', url: 'https://example.com/', status: 200, startedAt: '2026-08-13T00:00:01.000Z', durationMs: 80 })).toMatchObject({ ok: true });
    // 非法事件拒绝（非 http(s)/非法状态码）
    expect(adapter.recordEvent(session, { method: 'GET', url: 'file:///etc/passwd', status: 200, startedAt: 't', durationMs: 1 })).toMatchObject({
      ok: false, error: { code: 'HAR_CAPTURE_INVALID' },
    });
    const flushed = await adapter.flush(session, root);
    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;
    expect(existsSync(flushed.value.path)).toBe(true);
    const har = JSON.parse(readFileSync(flushed.value.path, 'utf8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries.map((entry: { request: { url: string } }) => entry.request.url))
      .toEqual(['https://example.com/', 'https://example.com/api/order']); // 按 startedAt 排序
    expect(createHash('sha256').update(readFileSync(flushed.value.path)).digest('hex')).toBe(flushed.value.sha256);
    // 轨迹桥接：network 通道映射
    expect(adapter.toNetworkEvents(session)).toEqual([
      { method: 'POST', url: 'https://example.com/api/order', status: 200 },
      { method: 'GET', url: 'https://example.com/', status: 200 },
    ]);
    // 空会话 flush 拒绝
    const empty = adapter.openSession('sess-b');
    if (empty.ok) await expect(adapter.flush(empty.value, root)).resolves.toMatchObject({
      ok: false, error: { code: 'HAR_CAPTURE_EMPTY' },
    });
  });
});

describe('exemplar 池 + 市场签名（最小版）', () => {
  it('stores and recalls few-shot exemplars most-recent-first with capacity cap', () => {
    const pool = new ExemplarPool(3);
    for (let index = 0; index < 5; index += 1) {
      expect(pool.add({ id: `e${index}`, capabilityKey: 'comment_sync', content: { index }, createdAt: `2026-08-13T00:00:0${index}.000Z` })).toMatchObject({ ok: true });
    }
    expect(pool.snapshot().length).toBe(3);
    expect(pool.recall('comment_sync').map(item => item.id)).toEqual(['e4', 'e3', 'e2']);
    expect(pool.recall('unknown_key')).toEqual([]);
    expect(pool.add({ id: 'x', capabilityKey: 'bad key!', content: {}, createdAt: 't' })).toMatchObject({
      ok: false, error: { code: 'EXEMPLAR_INVALID' },
    });
  });

  it('signs market items and rejects tampered payloads, wrong keys, and malformed signatures', () => {
    const signer = createSigningKeypair('market-key-1');
    const item = { id: 'skill-comment-sync', kind: 'skill' as const, version: '1.0.0', publisher: 'pub-a', payload: { name: 'comment-sync', files: ['SKILL.md'] }, expiry: null, scope: ['public'] };
    const signed = signMarketItem(signer, item);
    expect(signed.sha256).toBe(payloadDigestOf(item.payload));
    expect(verifyMarketItem(signer.publicKey, signed)).toMatchObject({ ok: true });
    // 篡改 payload → MARKET_SIGNATURE_INVALID
    const tampered = { ...signed, payload: { ...item.payload, files: ['SKILL.md', 'evil.sh'] } };
    expect(verifyMarketItem(signer.publicKey, tampered)).toMatchObject({
      ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' },
    });
    // 错误公钥 → 拒绝
    const otherKey = createSigningKeypair('market-key-2');
    expect(verifyMarketItem(otherKey.publicKey, signed)).toMatchObject({
      ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' },
    });
    // 畸形签名 → 拒绝（不抛异常）
    expect(verifyMarketItem(signer.publicKey, { ...signed, signature: 'not-base64!@#' })).toMatchObject({
      ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' },
    });
  });
});

describe('平台授权槽位（最小版）', () => {
  it('locks blocked channels: no evidence, revoked, suspended, and expired all block', () => {
    const registry = new PlatformAuthRegistry();
    expect(registry.isBlocked('platform-a')).toBe(true); // 无证据 → 物理锁定（红线 6）
    expect(registry.register({
      platformId: 'platform-a', channel: 'user-plus-platform', grantedBy: 'legal@example.com',
      grantedAt: '2026-08-01T00:00:00.000Z', expiresAt: null, status: 'active',
    })).toMatchObject({ ok: true });
    expect(registry.isBlocked('platform-a')).toBe(false);
    registry.suspend('platform-a'); // 封禁信号 → 熔断
    expect(registry.isBlocked('platform-a')).toBe(true);
    expect(registry.status('platform-a')?.status).toBe('suspended');
    registry.register({
      platformId: 'platform-b', channel: 'api', grantedBy: 'ops', grantedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:01.000Z', status: 'active',
    });
    expect(registry.isBlocked('platform-b')).toBe(true); // 到期自动失效（红线 5）
    registry.register({ platformId: 'platform-c', channel: 'public', grantedBy: 'public', grantedAt: 't', expiresAt: null, status: 'active' });
    registry.revoke('platform-c');
    expect(registry.isBlocked('platform-c')).toBe(true);
    expect(registry.register({ platformId: 'bad id!', channel: 'api', grantedBy: 'x', grantedAt: 't', expiresAt: null, status: 'active' })).toMatchObject({
      ok: false, error: { code: 'PLATFORM_AUTH_INVALID' },
    });
  });
});

describe('安装器 manifest（雏形）', () => {
  it('sanitizes app names, binds the entry sha256, and rejects invalid versions', () => {
    expect(sanitizeAppName('我的工坊/Pro*版')).toMatchObject({ ok: true, value: '我的工坊Pro版' });
    expect(sanitizeAppName('<>:\"/\\|?*')).toMatchObject({ ok: false, error: { code: 'INSTALLER_NAME_INVALID' } });
    const entry = Buffer.from('#!/usr/bin/env node\nconsole.log("wxnodus")\n');
    const manifest = buildInstallerManifest({ appName: 'WxNodus 工坊', version: '4.0.0', icon: '🛠️', entryPath: 'bin/wxnodus.js', entryBytes: entry });
    expect(manifest).toMatchObject({
      ok: true,
      value: { schemaVersion: 1, appName: 'WxNodus 工坊', version: '4.0.0', icon: '🛠️', entryPath: 'bin/wxnodus.js' },
    });
    if (!manifest.ok) return;
    expect(manifest.value.entrySha256).toBe(createHash('sha256').update(entry).digest('hex'));
    expect(buildInstallerManifest({ appName: 'x', version: '4.0', icon: null, entryPath: 'bin/x.js', entryBytes: entry })).toMatchObject({
      ok: false, error: { code: 'INSTALLER_VERSION_INVALID' },
    });
    // 入口字节漂移 → sha256 变化（安装器校验基础）
    const drifted = buildInstallerManifest({ appName: 'x', version: '4.0.0', icon: null, entryPath: 'bin/x.js', entryBytes: Buffer.from('changed') });
    expect(drifted.ok && drifted.value.entrySha256).not.toBe(manifest.value.entrySha256);
  });
});
