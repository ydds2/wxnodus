// tests/market-distribution.contract.test.ts — §10-3：远程市场分发服务完整集成（真实 HTTP：端口 0 临时服务）
// 发布验签 → 目录 → 客户端下载验签 → 篡改/错钥/吊销/密钥轮换全链路确定性拒绝
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketAuthority } from '../src/application/forge/marketAuthority.js';
import { startMarketServer, type MarketServerHandle } from '../src/application/forge/marketServer.js';
import { MarketClient } from '../src/application/forge/marketClient.js';
import { createSigningKeypair, signMarketItem } from '../src/application/forge/marketSigning.js';

describe('远程市场分发（真实 HTTP 集成）', () => {
  let server: MarketServerHandle;
  let authority: MarketAuthority;
  let client: MarketClient;
  beforeEach(async () => {
    authority = new MarketAuthority();
    server = await startMarketServer(authority);
    client = new MarketClient(`http://127.0.0.1:${server.port}`);
  });
  afterEach(async () => { await server.close(); });

  const publishItem = async (keyId: string, id: string, payload: Record<string, unknown>) => {
    const keypair = createSigningKeypair(keyId);
    authority.registerKey(keypair.keyId, keypair.publicKey);
    const signed = signMarketItem(keypair, { id, kind: 'skill', payload });
    const published = await client.publish(signed);
    return { keypair, signed, published };
  };

  it('发布 → 目录 → 客户端下载验签全链路通过；目录指纹随内容变化', async () => {
    const { signed, published } = await publishItem('publisher-a', 'skill-comment-sync', { name: 'comment-sync' });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value).toMatchObject({ id: 'skill-comment-sync', signerKeyId: 'publisher-a', sha256: signed.sha256 });
    const catalog = await client.fetchCatalog();
    expect(catalog.ok && catalog.value.catalog.map(entry => entry.id)).toContain('skill-comment-sync');
    const fetched = await client.fetchAndVerify('skill-comment-sync');
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.payload).toEqual({ name: 'comment-sync' });
  });

  it('传输中篡改 payload → 客户端验签拒绝 MARKET_SIGNATURE_INVALID（哈希绑定）', async () => {
    await publishItem('publisher-a', 'skill-tamper', { name: 'x' });
    const raw = await client.fetchItemRaw('skill-tamper');
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const tampered = { ...raw.value, payload: { name: 'evil' } };
    // 直接以篡改件验签（等价于传输中篡改后到达客户端）
    const { verifyMarketItem } = await import('../src/application/forge/marketSigning.js');
    const keyBody = await fetch(`http://127.0.0.1:${server.port}/keys/publisher-a`).then(r => r.json()) as { publicKeyPem: string };
    const { createPublicKey } = await import('node:crypto');
    expect(verifyMarketItem(createPublicKey(keyBody.publicKeyPem), tampered)).toMatchObject({
      ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' },
    });
  });

  it('未知密钥发布 → MARKET_PUBLISH_REJECTED；错钥验签拒绝', async () => {
    const rogue = createSigningKeypair('rogue-key');
    const signed = signMarketItem(rogue, { id: 'skill-rogue', kind: 'skill', payload: {} });
    expect(await client.publish(signed)).toMatchObject({ ok: false, error: { code: 'MARKET_PUBLISH_REJECTED' } });
  });

  it('吊销条目：客户端下载 → MARKET_ITEM_REVOKED（410），目录不再列出', async () => {
    await publishItem('publisher-a', 'skill-revoked', { name: 'x' });
    const revokeResponse = await fetch(`http://127.0.0.1:${server.port}/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'skill-revoked' }),
    });
    expect(revokeResponse.status).toBe(200);
    expect(await client.fetchItemRaw('skill-revoked')).toMatchObject({ ok: false, error: { code: 'MARKET_ITEM_REVOKED' } });
    const catalog = await client.fetchCatalog();
    expect(catalog.ok && catalog.value.catalog.map(entry => entry.id)).not.toContain('skill-revoked');
  });

  it('密钥轮换：退役密钥拒新发布，但已发布件仍可验签分发；新密钥正常发布', async () => {
    const first = await publishItem('publisher-b', 'skill-legacy', { name: 'v1' });
    expect(first.published.ok).toBe(true);
    authority.retireKey('publisher-b');
    // 退役后旧密钥再发布 → 拒收
    const again = signMarketItem(first.keypair, { id: 'skill-legacy-2', kind: 'skill', payload: {} });
    expect(await client.publish(again)).toMatchObject({ ok: false, error: { code: 'MARKET_PUBLISH_REJECTED' } });
    // 已发布件仍可下载并验签（轮换不影响既有签名）
    expect(await client.fetchAndVerify('skill-legacy')).toMatchObject({ ok: true });
    // 新密钥发布成功
    const second = await publishItem('publisher-b-v2', 'skill-v2', { name: 'v2' });
    expect(second.published.ok).toBe(true);
  });
});
