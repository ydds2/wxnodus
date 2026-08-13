// src/application/forge/marketClient.ts — 远程市场客户端（§10-3 完整集成）：
// fetchAndVerify：下载条目 → 按 signerKeyId 拉取公钥 → verifyMarketItem（载荷哈希 + Ed25519 双重校验）
// 410（吊销）/404（不存在）/传输失败分别映射为独立错误码——绝不把不可验证内容当可用交付
import { createPublicKey } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { verifyMarketItem, type MarketItem, type SignedMarketItem } from './marketSigning.js';
import type { CatalogEntry } from './marketAuthority.js';

export class MarketClient {
  constructor(private readonly baseUrl: string) {}

  async fetchItemRaw(id: string): Promise<OperationResult<SignedMarketItem>> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/items/${encodeURIComponent(id)}`); } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.transport', { id }) };
    }
    if (response.status === 404) return { ok: false, error: configError('MARKET_ITEM_NOT_FOUND', 'market.item.notFound', { id }) };
    if (response.status === 410) return { ok: false, error: configError('MARKET_ITEM_REVOKED', 'market.item.revoked', { id }) };
    if (!response.ok) return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.status', { id, status: response.status }) };
    try {
      const item = await response.json() as SignedMarketItem;
      return { ok: true, value: item };
    } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.body', { id }) };
    }
  }

  /** 下载 + 按发布者公钥验签（payload 篡改/错钥/畸形签名一律 MARKET_SIGNATURE_INVALID） */
  async fetchAndVerify(id: string): Promise<OperationResult<MarketItem>> {
    const fetched = await this.fetchItemRaw(id);
    if (!fetched.ok) return fetched;
    let keyResponse: Response;
    try { keyResponse = await fetch(`${this.baseUrl}/keys/${encodeURIComponent(fetched.value.signerKeyId)}`); } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.transport', { id }) };
    }
    if (!keyResponse.ok) return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.key', { keyId: fetched.value.signerKeyId }) };
    const keyBody = await keyResponse.json() as { publicKeyPem?: string };
    if (!keyBody.publicKeyPem) return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.key', { keyId: fetched.value.signerKeyId }) };
    try {
      return verifyMarketItem(createPublicKey(keyBody.publicKeyPem), fetched.value);
    } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.key', { keyId: fetched.value.signerKeyId }) };
    }
  }

  async fetchCatalog(): Promise<OperationResult<{ catalog: CatalogEntry[]; digest: string }>> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/catalog`); } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.transport', {}) };
    }
    if (!response.ok) return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.status', { status: response.status }) };
    try {
      return { ok: true, value: await response.json() as { catalog: CatalogEntry[]; digest: string } };
    } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.body', {}) };
    }
  }

  async publish(item: SignedMarketItem): Promise<OperationResult<CatalogEntry>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      });
    } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.transport', {}) };
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string };
      return { ok: false, error: configError(body.code ?? 'MARKET_PUBLISH_REJECTED', 'market.publish.rejected') };
    }
    const body = await response.json() as { entry: CatalogEntry };
    return { ok: true, value: body.entry };
  }
}
