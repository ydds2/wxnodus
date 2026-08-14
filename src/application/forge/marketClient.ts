// src/application/forge/marketClient.ts — W5-01 远程市场客户端（pinned 信任根）
// fetchAndVerify：下载条目 → 只用本地 pinned 信任根（active 根集）验签——绝不从 item server 获取公钥
// （攻击者同时替换 server 上的 key+item 也无法通过：pinned 根不含攻击者密钥）。
// 410（吊销）/404（不存在）/传输失败分别映射独立错误码——绝不把不可验证内容当可用交付。
import { randomUUID } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { verifyMarketItem, type SignedMarketItem } from './marketSigning.js';
import { createMarketTrustRootStore } from './marketTrustRoot.js';
import type { CatalogEntry } from './marketAuthority.js';

export interface MarketClientOptions {
  baseUrl: string;
  /** 本地 pinned 信任根文件（操作员离线建立——客户端唯一信任来源，绝不从 item server 获取） */
  trustRootFile: string;
  /** 发布用管理 token（可选；未提供 → 服务端 MARKET_UNAUTHORIZED） */
  token?: string;
}

export class MarketClient {
  private readonly trustRootStore;

  constructor(private readonly options: MarketClientOptions) {
    this.trustRootStore = createMarketTrustRootStore(options.trustRootFile);
  }

  async fetchItemRaw(id: string): Promise<OperationResult<SignedMarketItem>> {
    let response: Response;
    try { response = await fetch(`${this.options.baseUrl}/items/${encodeURIComponent(id)}`); } catch {
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

  /** 下载 + 本地 pinned 根验签（payload 篡改/错钥/未知签名者一律 MARKET_SIGNATURE_INVALID） */
  async fetchAndVerify(id: string): Promise<OperationResult<SignedMarketItem>> {
    const fetched = await this.fetchItemRaw(id);
    if (!fetched.ok) return fetched;
    const keys = this.trustRootStore.activePublicKeys();
    if (!keys.ok || keys.value.length === 0) {
      return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.trust.noActiveRoots') };
    }
    let lastError: OperationResult<SignedMarketItem> | null = null;
    for (const key of keys.value) {
      const verified = verifyMarketItem(key, fetched.value);
      if (verified.ok) return verified;
      lastError = verified;
    }
    return lastError ?? { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.signature.invalid') };
  }

  async fetchCatalog(): Promise<OperationResult<{ catalog: CatalogEntry[]; digest: string }>> {
    let response: Response;
    try { response = await fetch(`${this.options.baseUrl}/catalog`); } catch {
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
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-market-nonce': randomUUID() };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/publish`, { method: 'POST', headers, body: JSON.stringify(item) });
    } catch {
      return { ok: false, error: configError('MARKET_FETCH_FAILED', 'market.fetch.transport', {}) };
    }
    const body = await response.json().catch(() => ({})) as { code?: string; entry?: CatalogEntry };
    if (!response.ok) {
      const code = body.code ?? 'MARKET_PUBLISH_REJECTED';
      if (code === 'MARKET_UNAUTHORIZED') return { ok: false, error: configError('MARKET_UNAUTHORIZED', 'market.unauthorized') };
      if (code === 'MARKET_ITEM_VERSION_CONFLICT') return { ok: false, error: configError('MARKET_ITEM_VERSION_CONFLICT', 'market.item.version.conflict') };
      if (code === 'MARKET_NONCE_REPLAYED') return { ok: false, error: configError('MARKET_NONCE_REPLAYED', 'market.nonce.replayed') };
      return { ok: false, error: configError(code, 'market.publish.rejected') };
    }
    return { ok: true, value: body.entry! };
  }
}
