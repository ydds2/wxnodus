// src/application/forge/marketAuthority.ts — W5-01 市场权威核心（SQLite 持久化 + 信任根轮换）
// bootstrap 根（generation=1，操作员离线建立）→ 轮换 = 新根由现有 active 根签名授权（generation 单调递增）
// → 发布验签（仅 active 根可发布；退休根拒新发布但既有条目仍可取）→ 版本冲突检测 → 吊销 → 审计哈希链。
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { verifyMarketItem, verifyRootAuthorization, type SignedMarketItem } from './marketSigning.js';
import type { MarketRepository } from '../../infrastructure/sqlite/marketRepository.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CatalogEntry {
  id: string;
  kind: string;
  version: string;
  publisher: string;
  sha256: string;
  signerKeyId: string;
}

export interface MarketActionContext {
  actor: string;
  nonce: string;
}

export class MarketAuthority {
  constructor(private readonly repo: MarketRepository) {}

  /** bootstrap：仅当密钥表为空（generation=1，操作员离线建立——服务端信任锚初始录入） */
  bootstrapRoot(keyId: string, publicKeyPem: string): OperationResult<void> {
    if (!SAFE_ID.test(keyId)) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.invalid', { keyId }) };
    try { createPublicKey(publicKeyPem); } catch {
      return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.pem.invalid', { keyId }) };
    }
    if (this.repo.keyRecords().length > 0) {
      return { ok: false, error: configError('MARKET_ROOT_ALREADY_BOOTSTRAPPED', 'market.root.bootstrap.duplicate') };
    }
    return this.repo.registerKey(
      { keyId, publicKeyPem, generation: 1, status: 'active', authorizedByKeyId: null, authorizedBySignature: null },
      'operator-bootstrap', 'bootstrap', new Date().toISOString(),
    );
  }

  /** 轮换：generation 严格递增 + authorizedBy 签名经现有 active 根验证（伪造/非单调/退休根授权一律拒） */
  registerRoot(input: { keyId: string; publicKeyPem: string; generation: number; authorizedByKeyId: string; authorizedBySignature: string }, context: MarketActionContext = { actor: 'operator', nonce: `root-${Date.now()}` }): OperationResult<void> {
    if (!SAFE_ID.test(input.keyId)) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.invalid', { keyId: input.keyId }) };
    try { createPublicKey(input.publicKeyPem); } catch {
      return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.pem.invalid', { keyId: input.keyId }) };
    }
    const records = this.repo.keyRecords();
    const maxGeneration = records.reduce((m, r) => Math.max(m, r.generation), 0);
    if (input.generation <= maxGeneration) {
      return { ok: false, error: configError('MARKET_ROOT_GENERATION_INVALID', 'market.root.generation.invalid', { generation: input.generation, maxGeneration }) };
    }
    const authorizer = records.find(r => r.keyId === input.authorizedByKeyId && r.status === 'active');
    if (!authorizer) return { ok: false, error: configError('MARKET_ROOT_AUTHORIZATION_INVALID', 'market.root.authorizer.missing') };
    let authorizerKey: KeyObject;
    try { authorizerKey = createPublicKey(authorizer.publicKeyPem); } catch {
      return { ok: false, error: configError('MARKET_ROOT_AUTHORIZATION_INVALID', 'market.root.authorizer.invalid') };
    }
    const authorized = verifyRootAuthorization(authorizerKey, {
      keyId: input.keyId, generation: input.generation, publicKeyPem: input.publicKeyPem,
    }, input.authorizedBySignature);
    if (!authorized.ok) return authorized;
    return this.repo.registerKey(
      {
        keyId: input.keyId, publicKeyPem: input.publicKeyPem, generation: input.generation, status: 'active',
        authorizedByKeyId: input.authorizedByKeyId, authorizedBySignature: input.authorizedBySignature,
      },
      context.actor, context.nonce, new Date().toISOString(),
    );
  }

  /** 退休：阻止新发布与新授权；既有条目不受影响（吊销仅作用于条目） */
  retireKey(keyId: string, context: MarketActionContext = { actor: 'operator', nonce: `retire-${Date.now()}` }): OperationResult<void> {
    return this.repo.retireKey(keyId, context.actor, context.nonce, new Date().toISOString());
  }

  revokeKey(keyId: string, context: MarketActionContext = { actor: 'operator', nonce: `revokekey-${Date.now()}` }): OperationResult<void> {
    return this.repo.revokeKey(keyId, context.actor, context.nonce, new Date().toISOString());
  }

  publish(item: SignedMarketItem, context: MarketActionContext): OperationResult<CatalogEntry> {
    if (!SAFE_ID.test(item.id)) {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.id.invalid') };
    }
    const key = this.repo.getKeyPem(item.signerKeyId);
    if (!key.ok) return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.key.unknown', { keyId: item.signerKeyId }) };
    const record = this.repo.keyRecords().find(r => r.keyId === item.signerKeyId);
    if (record?.status !== 'active') {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.key.retired', { keyId: item.signerKeyId }) };
    }
    let publicKey: KeyObject;
    try { publicKey = createPublicKey(key.value); } catch {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.key.invalid', { keyId: item.signerKeyId }) };
    }
    const verified = verifyMarketItem(publicKey, item);
    if (!verified.ok) {
      return { ok: false, error: configError('MARKET_PUBLISH_REJECTED', 'market.publish.signature.invalid') };
    }
    const stored = this.repo.publish(item, context.actor, context.nonce, new Date().toISOString());
    if (!stored.ok) return stored;
    return { ok: true, value: { id: item.id, kind: item.kind, version: item.version, publisher: item.publisher, sha256: item.sha256, signerKeyId: item.signerKeyId } };
  }

  getItem(id: string): OperationResult<SignedMarketItem> {
    return this.repo.get(id);
  }

  revoke(id: string, context: MarketActionContext): OperationResult<void> {
    return this.repo.revoke(id, context.actor, context.nonce, new Date().toISOString());
  }

  listCatalog(): CatalogEntry[] {
    return this.repo.listCatalog();
  }

  publicKeyPem(keyId: string): OperationResult<string> {
    return this.repo.getKeyPem(keyId);
  }

  /** 目录条目数（含已吊销）——审计用 */
  catalogSize(): number {
    return this.repo.listCatalog().length + this.repo.keyRecords().filter(r => r.status === 'revoked').length;
  }

  /** 目录整体指纹（sha256 over 目录条目）——分发一致性校验 */
  catalogDigest(): string {
    const entries = this.listCatalog().map(entry => `${entry.id}:${entry.sha256}`).sort().join('\n');
    return createHash('sha256').update(entries).digest('hex');
  }

  verifyAuditChain(): OperationResult<void> {
    return this.repo.verifyAuditChain();
  }
}
