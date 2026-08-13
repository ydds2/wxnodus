// src/application/forge/marketAuthority.ts — 远程市场权威核心（§10-3 完整集成，纯内存、可无 HTTP 单元测试）：
// 公钥注册/退役（密钥轮换）→ 发布验签（Ed25519，未知/退役密钥拒收）→ 目录 → 吊销（已发布件不可分发）
// 密钥轮换语义：退役只阻止「新发布」，已发布件的既有签名仍可验证（吊销仅作用于条目）
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { verifyMarketItem, type SignedMarketItem } from './marketSigning.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CatalogEntry {
  id: string;
  kind: 'mcp-server' | 'skill' | 'recipe';
  sha256: string;
  signerKeyId: string;
}

export class MarketAuthority {
  private readonly keys = new Map<string, KeyObject>();
  private readonly retiredKeys = new Set<string>();
  private readonly revokedItems = new Set<string>();
  private readonly catalog = new Map<string, SignedMarketItem>();

  registerKey(keyId: string, publicKey: KeyObject): OperationResult<void> {
    if (!SAFE_ID.test(keyId)) {
      return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.invalid', { keyId }) };
    }
    this.keys.set(keyId, publicKey);
    return { ok: true, value: undefined };
  }

  registerKeyPem(keyId: string, publicKeyPem: string): OperationResult<void> {
    if (!SAFE_ID.test(keyId)) {
      return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.invalid', { keyId }) };
    }
    let key: KeyObject;
    try { key = createPublicKey(publicKeyPem); } catch {
      return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.pem.invalid', { keyId }) };
    }
    this.keys.set(keyId, key);
    return { ok: true, value: undefined };
  }

  /** 密钥轮换：退役旧密钥（阻止新发布；已发布件不受影响） */
  retireKey(keyId: string): OperationResult<void> {
    if (!this.keys.has(keyId)) {
      return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.unknown', { keyId }) };
    }
    this.retiredKeys.add(keyId);
    return { ok: true, value: undefined };
  }

  publish(item: SignedMarketItem): OperationResult<CatalogEntry> {
    if (!SAFE_ID.test(item.id)) {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.id.invalid') };
    }
    const key = this.keys.get(item.signerKeyId);
    if (!key) {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.key.unknown', { keyId: item.signerKeyId }) };
    }
    if (this.retiredKeys.has(item.signerKeyId)) {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.key.retired', { keyId: item.signerKeyId }) };
    }
    const verified = verifyMarketItem(key, item);
    if (!verified.ok) {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.signature.invalid') };
    }
    this.catalog.set(item.id, item);
    return { ok: true, value: { id: item.id, kind: item.kind, sha256: item.sha256, signerKeyId: item.signerKeyId } };
  }

  getItem(id: string): OperationResult<SignedMarketItem> {
    const item = this.catalog.get(id);
    if (!item) return { ok: false, error: configError('MARKET_ITEM_NOT_FOUND', 'market.item.notFound', { id }) };
    if (this.revokedItems.has(id)) return { ok: false, error: configError('MARKET_ITEM_REVOKED', 'market.item.revoked', { id }) };
    return { ok: true, value: item };
  }

  revoke(id: string): OperationResult<void> {
    if (!this.catalog.has(id)) return { ok: false, error: configError('MARKET_ITEM_NOT_FOUND', 'market.item.notFound', { id }) };
    this.revokedItems.add(id);
    return { ok: true, value: undefined };
  }

  listCatalog(): CatalogEntry[] {
    return [...this.catalog.entries()]
      .filter(([id]) => !this.revokedItems.has(id))
      .map(([, item]) => ({ id: item.id, kind: item.kind, sha256: item.sha256, signerKeyId: item.signerKeyId }));
  }

  publicKeyPem(keyId: string): OperationResult<string> {
    const key = this.keys.get(keyId);
    if (!key) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.unknown', { keyId }) };
    return { ok: true, value: key.export({ type: 'spki', format: 'pem' }).toString() };
  }

  /** 目录条目数（含已吊销）——审计用 */
  catalogSize(): number { return this.catalog.size; }

  /** 目录整体指纹（sha256 over 目录条目）——分发一致性校验 */
  catalogDigest(): string {
    const entries = this.listCatalog().map(entry => `${entry.id}:${entry.sha256}`).sort().join('\n');
    return createHash('sha256').update(entries).digest('hex');
  }
}
