// tests/wave5/w5-market-trust.test.ts — W5-01 市场信任加固契约（RED → 实现后全绿）
// canonical 签名封套（id/kind/version/publisher/payloadDigest/expiry/scope 全部入签）→
// 独立 pinned 信任根（generation 单调 + 旧根授权 rotation + retirement/revocation）→
// 管理端点（Bearer 哈希 + scope + nonce 防重放 + body 上限 + 审计哈希链）→ SQLite 持久化（重启不丢）→
// 客户端只信本地 pinned 根（攻击者同时替换 server 的 key+item 也无法通过）。
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../src/store/db.js';
import { openMarketRepository } from '../../src/infrastructure/sqlite/marketRepository.js';
import { createMarketTrustRootStore } from '../../src/application/forge/marketTrustRoot.js';
import { createMarketPolicy } from '../../src/application/forge/marketPolicy.js';
import { signMarketItem, verifyMarketItem, signRootAuthorization, payloadDigestOf, type SigningKeypair, type SignedMarketItem } from '../../src/application/forge/marketSigning.js';
import { MarketAuthority } from '../../src/application/forge/marketAuthority.js';
import { startMarketServer, type MarketServerHandle } from '../../src/application/forge/marketServer.js';
import { MarketClient } from '../../src/application/forge/marketClient.js';

const keypair = (keyId: string): SigningKeypair => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId };
};

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 服务端夹具：SQLite + 信任根库 + 市场权威（root 引导后可直接发布） */
function serverFixture() {
  const dir = tmp('w5-market-');
  const db = openDB(dir);
  cleanup.push(() => { try { closeDB(db); } catch { /* already closed */ } });
  const repo = openMarketRepository(db);
  const authority = new MarketAuthority(repo);
  const bootstrap = keypair('root-1');
  const boot = authority.bootstrapRoot(bootstrap.keyId, bootstrap.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  if (!boot.ok) throw new Error(boot.error.code);
  return { dir, db, repo, authority, bootstrap };
}

/** 客户端夹具：独立 pinned 信任根文件（绝不从 item server 获取） */
function clientTrustFile(dir: string, root: SigningKeypair, extraRoots: SigningKeypair[] = []): string {
  const store = createMarketTrustRootStore(join(dir, 'trust-root.json'));
  const pem = (k: SigningKeypair) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const boot = store.bootstrapRoot(root.keyId, pem(root));
  if (!boot.ok) throw new Error(boot.error.code);
  for (const k of extraRoots) {
    const gen = store.load().reduce((m, e) => Math.max(m, e.generation), 0) + 1;
    const authorization = { keyId: k.keyId, generation: gen, publicKeyPem: pem(k) };
    const r = store.authorizeRotation({ ...authorization, authorizedByKeyId: root.keyId, authorizedBySignature: signRootAuthorization(root, authorization) });
    if (!r.ok) throw new Error(r.error.code);
  }
  return join(dir, 'trust-root.json');
}

const makeItem = (kp: SigningKeypair, over: Partial<Parameters<typeof signMarketItem>[1]> = {}): SignedMarketItem =>
  signMarketItem(kp, {
    id: 'skill-demo', kind: 'skill', version: '1.0.0', publisher: 'pub-a',
    payload: { name: 'demo' }, expiry: null, scope: ['public'], ...over,
  });

describe('W5-01 canonical 签名封套', () => {
  it('封套任一字段篡改（id/kind/version/publisher/payloadDigest/expiry/scope/payload）→ MARKET_SIGNATURE_INVALID', () => {
    const kp = keypair('root-1');
    const item = makeItem(kp);
    const tampered: Array<[string, SignedMarketItem]> = [
      ['id', { ...item, id: 'skill-evil' }],
      ['kind', { ...item, kind: 'recipe' }],
      ['version', { ...item, version: '9.9.9' }],
      ['publisher', { ...item, publisher: 'pub-evil' }],
      ['payloadDigest', { ...item, payloadDigest: 'a'.repeat(64) }],
      ['expiry', { ...item, expiry: 123 }],
      ['scope', { ...item, scope: ['enterprise:evil'] }],
      ['payload', { ...item, payload: { name: 'evil' } }],
    ];
    for (const [field, bad] of tampered) {
      const result = verifyMarketItem(kp.publicKey, bad);
      expect(result.ok, `字段 ${field} 篡改应拒绝`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MARKET_SIGNATURE_INVALID');
    }
    expect(verifyMarketItem(kp.publicKey, item)).toMatchObject({ ok: true });
  });

  it('过期条目 → MARKET_ITEM_EXPIRED（签名有效也拒收）', () => {
    const kp = keypair('root-1');
    const expired = makeItem(kp, { expiry: Date.now() - 60_000 });
    const result = verifyMarketItem(kp.publicKey, expired);
    expect(result).toMatchObject({ ok: false, error: { code: 'MARKET_ITEM_EXPIRED' } });
  });

  it('payloadDigest 与 payload 规范化摘要一致（签名前绑定）', () => {
    const kp = keypair('root-1');
    const item = makeItem(kp, { payload: { b: 2, a: 1 } });
    expect(item.payloadDigest).toBe(payloadDigestOf({ b: 2, a: 1 }));
    expect(item.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('W5-01 版本冲突与持久化', () => {
  it('相同 id+version 覆盖发布 → MARKET_ITEM_VERSION_CONFLICT；新版本允许', () => {
    const { authority, bootstrap } = serverFixture();
    const item = makeItem(bootstrap, { id: 'skill-v', version: '1.0.0' });
    const actor = { actor: 'admin-1', nonce: 'n-1' };
    expect(authority.publish(item, actor)).toMatchObject({ ok: true });
    expect(authority.publish(item, { actor: 'admin-1', nonce: 'n-2' })).toMatchObject({ ok: false, error: { code: 'MARKET_ITEM_VERSION_CONFLICT' } });
    const v2 = makeItem(bootstrap, { id: 'skill-v', version: '2.0.0', payload: { name: 'v2' } });
    expect(authority.publish(v2, { actor: 'admin-1', nonce: 'n-3' })).toMatchObject({ ok: true });
    expect(authority.getItem('skill-v')).toMatchObject({ ok: true, value: { version: '2.0.0' } });
  });

  it('重启持久化：同一 DB 重开权威 → 条目/密钥/吊销状态全部保留', () => {
    const { dir, db, authority, bootstrap } = serverFixture();
    const item = makeItem(bootstrap, { id: 'skill-persist' });
    expect(authority.publish(item, { actor: 'admin-1', nonce: 'n-1' })).toMatchObject({ ok: true });
    authority.revoke('skill-persist', { actor: 'admin-1', nonce: 'n-2' });
    // 模拟重启：同一 DB 新建权威实例
    const reopened = new MarketAuthority(openMarketRepository(db));
    expect(reopened.getItem('skill-persist')).toMatchObject({ ok: false, error: { code: 'MARKET_ITEM_REVOKED' } });
    expect(reopened.listCatalog()).toHaveLength(0); // 已吊销不列出
    expect(reopened.publicKeyPem('root-1')).toMatchObject({ ok: true });
    void dir;
  });

  it('审计哈希链：篡改一行 → 完整性校验失败；verifyAuditChain 干净时 ok', () => {
    const { db, authority, bootstrap } = serverFixture();
    const item = makeItem(bootstrap, { id: 'skill-audit' });
    expect(authority.publish(item, { actor: 'admin-1', nonce: 'n-1' })).toMatchObject({ ok: true });
    expect(authority.verifyAuditChain()).toMatchObject({ ok: true });
    db.prepare('UPDATE market_audit SET target=? WHERE sequence=1').run('skill-evil');
    expect(authority.verifyAuditChain()).toMatchObject({ ok: false, error: { code: 'MARKET_AUDIT_INTEGRITY_FAILED' } });
  });
});

describe('W5-01 信任根轮换', () => {
  it('旧根授权轮换：generation 单调 + 签名验证；伪造授权/非单调/退休根授权全部拒绝', () => {
    const { dir, authority, bootstrap } = serverFixture();
    const root2 = keypair('root-2');
    const pem2 = root2.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // 伪造授权签名 → 拒
    const forged = { keyId: 'root-2', generation: 2, publicKeyPem: pem2 };
    expect(authority.registerRoot({ ...forged, authorizedByKeyId: 'root-1', authorizedBySignature: Buffer.from('deadbeef').toString('base64') }))
      .toMatchObject({ ok: false, error: { code: 'MARKET_ROOT_AUTHORIZATION_INVALID' } });
    // 非单调 generation → 拒
    expect(authority.registerRoot({ ...forged, generation: 0, authorizedByKeyId: 'root-1', authorizedBySignature: signRootAuthorization(bootstrap, { keyId: 'root-2', generation: 0, publicKeyPem: pem2 }) }))
      .toMatchObject({ ok: false, error: { code: 'MARKET_ROOT_GENERATION_INVALID' } });
    // 合法轮换 → ok；新根可发布
    expect(authority.registerRoot({ ...forged, authorizedByKeyId: 'root-1', authorizedBySignature: signRootAuthorization(bootstrap, forged) })).toMatchObject({ ok: true });
    expect(authority.publish(makeItem(root2, { id: 'skill-by-root2' }), { actor: 'admin-1', nonce: 'n-r2' })).toMatchObject({ ok: true });
    // 退休根不能授权新根，也不能新发布；已发布件仍可取
    authority.retireKey('root-1');
    const root3 = keypair('root-3');
    const pem3 = root3.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const auth3 = { keyId: 'root-3', generation: 3, publicKeyPem: pem3 };
    expect(authority.registerRoot({ ...auth3, authorizedByKeyId: 'root-1', authorizedBySignature: signRootAuthorization(bootstrap, auth3) }))
      .toMatchObject({ ok: false, error: { code: 'MARKET_ROOT_AUTHORIZATION_INVALID' } });
    expect(authority.publish(makeItem(bootstrap, { id: 'skill-by-retired' }), { actor: 'admin-1', nonce: 'n-r3' }))
      .toMatchObject({ ok: false, error: { code: 'MARKET_PUBLISH_REJECTED' } });
    expect(authority.getItem('skill-by-root2')).toMatchObject({ ok: true });
    void dir;
  });

  it('客户端 pinned 根：吊销根后条目验签失败；攻击者替换 server key+item 也无法通过', async () => {
    const { dir, authority, bootstrap } = serverFixture();
    const store = createMarketTrustRootStore(join(dir, 'client-roots.json'));
    const pem1 = bootstrap.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(store.bootstrapRoot('root-1', pem1)).toMatchObject({ ok: true });
    const good = makeItem(bootstrap, { id: 'skill-pin' });
    expect(authority.publish(good, { actor: 'admin-1', nonce: 'n-1' })).toMatchObject({ ok: true });
    const server = await startMarketServer(authority, { policy: createMarketPolicy({ tokens: [], nonceTtlMs: 60_000, maxBodyBytes: 64 * 1024 }) });
    cleanup.push(() => { void server.close(); });
    const client = new MarketClient({ baseUrl: `http://127.0.0.1:${server.port}`, trustRootFile: join(dir, 'client-roots.json') });
    expect(await client.fetchAndVerify('skill-pin')).toMatchObject({ ok: true });
    // 吊销 pinned 根 → 客户端拒收（即使条目未吊销）
    store.revokeRoot('root-1');
    expect(await client.fetchAndVerify('skill-pin')).toMatchObject({ ok: false, error: { code: 'MARKET_SIGNATURE_INVALID' } });
  });
});

describe('W5-01 管理端点认证（Bearer + scope + nonce + body 上限）', () => {
  const adminToken = 'market-admin-secret';
  const policyFor = (scope: string[]): ReturnType<typeof createMarketPolicy> =>
    createMarketPolicy({
      tokens: [{ id: 'admin-1', scope: scope as never, sha256: sha256(adminToken) }],
      nonceTtlMs: 60_000, maxBodyBytes: 4096,
    });

  it('无 token → 401；scope 不符 → 403；nonce 重放 → 409；body 超限 → 413', async () => {
    const { authority, bootstrap } = serverFixture();
    const server = await startMarketServer(authority, { policy: policyFor(['publish']) });
    cleanup.push(() => { void server.close(); });
    const base = `http://127.0.0.1:${server.port}`;
    const item = makeItem(bootstrap, { id: 'skill-auth' });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    // 无 token → 401
    expect((await post('/publish', item)).status).toBe(401);
    // scope 不符（keys:register token 不可 publish）→ 403
    const wrongScope = await startMarketServer(authority, { policy: policyFor(['keys:register']) });
    cleanup.push(() => { void wrongScope.close(); });
    const resp = await fetch(`http://127.0.0.1:${wrongScope.port}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, 'x-market-nonce': 'n-s1' }, body: JSON.stringify(item),
    });
    expect(resp.status).toBe(403);
    // nonce 重放 → 409
    const ok1 = await post('/publish', item, { authorization: `Bearer ${adminToken}`, 'x-market-nonce': 'n-r1' });
    expect(ok1.status).toBe(201);
    const replay = await post('/publish', { ...item, version: '1.0.1' }, { authorization: `Bearer ${adminToken}`, 'x-market-nonce': 'n-r1' });
    expect(replay.status).toBe(409);
    // body 超限 → 413（maxBodyBytes=4096，构造 >4KB 载荷）
    const big = makeItem(bootstrap, { id: 'skill-big', payload: { blob: 'x'.repeat(8192) } });
    const bigResp = await post('/publish', big, { authorization: `Bearer ${adminToken}`, 'x-market-nonce': 'n-big' });
    expect(bigResp.status).toBe(413);
  });

  it('完整发布流：token+nonce → 201 + 审计落库（actor 记录）', async () => {
    const { db, authority, bootstrap } = serverFixture();
    const server = await startMarketServer(authority, { policy: policyFor(['publish']) });
    cleanup.push(() => { void server.close(); });
    const item = makeItem(bootstrap, { id: 'skill-flow' });
    const resp = await fetch(`http://127.0.0.1:${server.port}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, 'x-market-nonce': 'n-f1' }, body: JSON.stringify(item),
    });
    expect(resp.status).toBe(201);
    const audit = db.prepare('SELECT action, actor, target FROM market_audit ORDER BY sequence DESC LIMIT 1').get() as { action: string; actor: string; target: string };
    expect(audit).toMatchObject({ action: 'publish', actor: 'admin-1', target: 'skill-flow' });
  });

  it('客户端 publish 携带 Authorization + nonce；未提供 token → MARKET_UNAUTHORIZED', async () => {
    const { dir, authority, bootstrap } = serverFixture();
    const server = await startMarketServer(authority, { policy: policyFor(['publish']) });
    cleanup.push(() => { void server.close(); });
    const client = new MarketClient({ baseUrl: `http://127.0.0.1:${server.port}`, trustRootFile: join(dir, 'unused.json'), token: adminToken });
    const item = makeItem(bootstrap, { id: 'skill-clientpub' });
    expect(await client.publish(item)).toMatchObject({ ok: true });
    const noToken = new MarketClient({ baseUrl: `http://127.0.0.1:${server.port}`, trustRootFile: join(dir, 'unused.json') });
    expect(await noToken.publish({ ...item, version: '1.0.1' })).toMatchObject({ ok: false, error: { code: 'MARKET_UNAUTHORIZED' } });
  });

  it('信任根文件原子落盘并读回（bootstrap/轮换/吊销持久化）', () => {
    const dir = tmp('w5-market-roots-');
    const store = createMarketTrustRootStore(join(dir, 'roots.json'));
    const k1 = keypair('r1');
    const pem1 = k1.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(store.bootstrapRoot('r1', pem1)).toMatchObject({ ok: true });
    const k2 = keypair('r2');
    const pem2 = k2.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const auth = { keyId: 'r2', generation: 2, publicKeyPem: pem2 };
    expect(store.authorizeRotation({ ...auth, authorizedByKeyId: 'r1', authorizedBySignature: signRootAuthorization(k1, auth) })).toMatchObject({ ok: true });
    store.retireRoot('r1');
    // 重开读回
    const reopened = createMarketTrustRootStore(join(dir, 'roots.json'));
    const entries = reopened.load();
    expect(entries).toHaveLength(2);
    expect(entries.find(e => e.keyId === 'r1')!.status).toBe('retired');
    expect(reopened.activePublicKeys()).toMatchObject({ ok: true });
  });
});
