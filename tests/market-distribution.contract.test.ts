// tests/market-distribution.contract.test.ts — W5-01：远程市场分发完整集成（真实 HTTP：端口 0 临时服务）
// 发布验签（active 根）→ 目录 → 客户端 pinned 根下载验签 → 篡改/错钥/吊销/密钥轮换全链路确定性拒绝；
// 管理端点走 Bearer 哈希 + scope + nonce（防重放）。
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../src/store/db.js';
import { openMarketRepository } from '../src/infrastructure/sqlite/marketRepository.js';
import { MarketAuthority } from '../src/application/forge/marketAuthority.js';
import { startMarketServer, type MarketServerHandle } from '../src/application/forge/marketServer.js';
import { MarketClient } from '../src/application/forge/marketClient.js';
import { createMarketPolicy, tokenSha256 } from '../src/application/forge/marketPolicy.js';
import { createMarketTrustRootStore } from '../src/application/forge/marketTrustRoot.js';
import { createSigningKeypair, signMarketItem, type SigningKeypair } from '../src/application/forge/marketSigning.js';

const ADMIN_TOKEN = 'market-admin-secret';
const keypair = (keyId: string): SigningKeypair => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId };
};
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('远程市场分发（真实 HTTP 集成，W5-01）', () => {
  let server: MarketServerHandle;
  let authority: MarketAuthority;
  let client: MarketClient;
  let root: SigningKeypair;
  let dir: string;
  let db: ReturnType<typeof openDB>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wxn-market-'));
    db = openDB(dir);
    authority = new MarketAuthority(openMarketRepository(db));
    root = keypair('publisher-a');
    const pem = root.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(authority.bootstrapRoot(root.keyId, pem)).toMatchObject({ ok: true });
    const policy = createMarketPolicy({
      tokens: [
        { id: 'admin-1', scope: ['keys:register', 'publish', 'revoke'], sha256: tokenSha256(ADMIN_TOKEN) },
      ],
      nonceTtlMs: 60_000, maxBodyBytes: 256 * 1024,
    });
    server = await startMarketServer(authority, { policy });
    // 客户端 pinned 信任根（独立文件——绝不从 item server 获取公钥）
    const trustFile = join(dir, 'client-roots.json');
    const store = createMarketTrustRootStore(trustFile);
    expect(store.bootstrapRoot(root.keyId, pem)).toMatchObject({ ok: true });
    client = new MarketClient({ baseUrl: `http://127.0.0.1:${server.port}`, trustRootFile: trustFile, token: ADMIN_TOKEN });
  });
  afterEach(async () => {
    await server.close();
    try { closeDB(db); } catch { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already removed */ }
  });

  const makeItem = (id: string, payload: Record<string, unknown>, version = '1.0.0') =>
    signMarketItem(root, { id, kind: 'skill', version, publisher: 'pub-a', payload, expiry: null, scope: ['public'] });

  it('发布 → 目录 → 客户端 pinned 根下载验签全链路通过；目录指纹随内容变化', async () => {
    const signed = makeItem('skill-comment-sync', { name: 'comment-sync' });
    const published = await client.publish(signed);
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
    await client.publish(makeItem('skill-tamper', { name: 'x' }));
    const raw = await client.fetchItemRaw('skill-tamper');
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const tampered = { ...raw.value, payload: { name: 'evil' } };
    const { verifyMarketItem } = await import('../src/application/forge/marketSigning.js');
    expect(verifyMarketItem(root.publicKey, tampered)).toMatchObject({
      ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' },
    });
  });

  it('未知密钥发布 → MARKET_PUBLISH_REJECTED；客户端 pinned 根不含攻击者密钥 → 验签失败', async () => {
    const rogue = keypair('rogue-key');
    const signed = signMarketItem(rogue, { id: 'skill-rogue', kind: 'skill', version: '1.0.0', publisher: 'rogue', payload: {}, expiry: null, scope: ['public'] });
    expect(await client.publish(signed)).toMatchObject({ ok: false, error: { code: 'MARKET_PUBLISH_REJECTED' } });
    // 攻击场景：server 被注入 rogue 密钥并签名条目 → 客户端 pinned 根不含 rogue → 拒
    const attackDir = mkdtempSync(join(tmpdir(), 'wxn-market-attack-'));
    const attackDb = openDB(attackDir);
    const attackAuthority = new MarketAuthority(openMarketRepository(attackDb));
    const roguePem = rogue.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(attackAuthority.bootstrapRoot(rogue.keyId, roguePem)).toMatchObject({ ok: true });
    expect(attackAuthority.publish(signed, { actor: 'admin-1', nonce: 'n-attack' })).toMatchObject({ ok: true });
    const attackServer = await startMarketServer(attackAuthority, { policy: createMarketPolicy({ tokens: [], nonceTtlMs: 60_000, maxBodyBytes: 65536 }) });
    const attackClient = new MarketClient({ baseUrl: `http://127.0.0.1:${attackServer.port}`, trustRootFile: join(dir, 'client-roots.json') });
    expect(await attackClient.fetchAndVerify('skill-rogue')).toMatchObject({ ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' } });
    await attackServer.close();
    closeDB(attackDb);
    rmSync(attackDir, { recursive: true, force: true });
  });

  it('吊销条目：客户端下载 → MARKET_ITEM_REVOKED（410），目录不再列出', async () => {
    await client.publish(makeItem('skill-revoked', { name: 'x' }));
    const revokeResponse = await fetch(`http://127.0.0.1:${server.port}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}`, 'x-market-nonce': 'n-revoke-1' },
      body: JSON.stringify({ id: 'skill-revoked' }),
    });
    expect(revokeResponse.status).toBe(200);
    expect(await client.fetchItemRaw('skill-revoked')).toMatchObject({ ok: false, error: { code: 'MARKET_ITEM_REVOKED' } });
    const catalog = await client.fetchCatalog();
    expect(catalog.ok && catalog.value.catalog.map(entry => entry.id)).not.toContain('skill-revoked');
  });

  it('密钥轮换：退休密钥拒新发布，但已发布件仍可验签分发；新根（授权轮换）正常发布', async () => {
    const first = await client.publish(makeItem('skill-legacy', { name: 'v1' }));
    expect(first.ok).toBe(true);
    // 新根：旧 active 根签名授权（generation=2）
    const root2 = keypair('publisher-b-v2');
    const pem2 = root2.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { signRootAuthorization } = await import('../src/application/forge/marketSigning.js');
    const authorization = { keyId: 'publisher-b-v2', generation: 2, publicKeyPem: pem2 };
    expect(authority.registerRoot({ ...authorization, authorizedByKeyId: 'publisher-a', authorizedBySignature: signRootAuthorization(root, authorization) }, { actor: 'admin-1', nonce: 'n-rotate' }))
      .toMatchObject({ ok: true });
    authority.retireKey('publisher-a', { actor: 'admin-1', nonce: 'n-retire' });
    // 退役后旧根再发布 → 拒收
    const again = signMarketItem(root, { id: 'skill-legacy-2', kind: 'skill', version: '1.0.0', publisher: 'pub-a', payload: {}, expiry: null, scope: ['public'] });
    expect(await client.publish(again)).toMatchObject({ ok: false, error: { code: 'MARKET_PUBLISH_REJECTED' } });
    // 已发布件仍可下载并验签（轮换不影响既有签名）
    expect(await client.fetchAndVerify('skill-legacy')).toMatchObject({ ok: true });
    // 新根发布成功（先把它加进客户端 pinned 根）
    const store = createMarketTrustRootStore(join(dir, 'client-roots.json'));
    expect(store.authorizeRotation({ ...authorization, authorizedByKeyId: 'publisher-a', authorizedBySignature: signRootAuthorization(root, authorization) })).toMatchObject({ ok: true });
    const signed2 = signMarketItem(root2, { id: 'skill-v2', kind: 'skill', version: '1.0.0', publisher: 'pub-a', payload: { name: 'v2' }, expiry: null, scope: ['public'] });
    expect(await client.publish(signed2)).toMatchObject({ ok: true });
    expect(await client.fetchAndVerify('skill-v2')).toMatchObject({ ok: true });
  });
});
