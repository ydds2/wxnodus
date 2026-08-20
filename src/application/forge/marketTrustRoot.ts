// src/application/forge/marketTrustRoot.ts — W5-01 独立 pinned 信任根库（文件持久化、原子写）
// 信任模型：操作员离线建立 bootstrap 根（generation=1）；轮换 = 新根由现有 active 根签名授权，
// generation 严格单调递增；退休根不再授权/发布但既有条目仍可验；吊销根即刻失效。
// 客户端只信本地 pinned 文件——绝不从 item server 获取公钥（TOFU 攻击面消除）。
import { createPublicKey, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { verifyRootAuthorization } from './marketSigning.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface TrustRootEntry {
  keyId: string;
  publicKeyPem: string;
  generation: number;
  status: 'active' | 'retired' | 'revoked';
  authorizedByKeyId?: string;
  authorizedBySignature?: string;
  createdAt: string;
}

export interface MarketTrustRootStore {
  readonly file: string;
  load(): TrustRootEntry[];
  /** bootstrap：仅当 store 为空（generation=1，操作员离线建立——本地文件即信任锚） */
  bootstrapRoot(keyId: string, publicKeyPem: string): OperationResult<void>;
  /** 轮换：generation 严格递增 + authorizedBy 签名经现有 active 根验证 */
  authorizeRotation(input: { keyId: string; publicKeyPem: string; generation: number; authorizedByKeyId: string; authorizedBySignature: string }): OperationResult<void>;
  retireRoot(keyId: string): OperationResult<void>;
  revokeRoot(keyId: string): OperationResult<void>;
  activePublicKeys(): OperationResult<KeyObject[]>;
  get(keyId: string): TrustRootEntry | null;
}

export function createMarketTrustRootStore(file: string, options: { now?: () => string } = {}): MarketTrustRootStore {
  const now = options.now ?? (() => new Date().toISOString());
  const load = (): TrustRootEntry[] => {
    if (!existsSync(file)) return [];
    try { return JSON.parse(readFileSync(file, 'utf8')) as TrustRootEntry[]; } catch { return []; }
  };
  const save = (entries: TrustRootEntry[]): void => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    try {
      const fd = openSync(tmp, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch { /* Windows 某些文件系统 fsync 只读句柄 EPERM——继续 rename（数据已完整写盘） */ }
    renameSync(tmp, file);
    rmSync(tmp, { force: true });
  };

  return {
    file,
    load,
    bootstrapRoot(keyId, publicKeyPem) {
      if (!SAFE_ID.test(keyId)) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.invalid', { keyId }) };
      try { createPublicKey(publicKeyPem); } catch { return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.pem.invalid', { keyId }) }; }
      const entries = load();
      if (entries.length > 0) return { ok: false, error: configError('MARKET_ROOT_ALREADY_BOOTSTRAPPED', 'market.root.bootstrap.duplicate') };
      save([{ keyId, publicKeyPem, generation: 1, status: 'active', createdAt: now() }]);
      return { ok: true, value: undefined };
    },
    authorizeRotation(input) {
      if (!SAFE_ID.test(input.keyId)) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.invalid', { keyId: input.keyId }) };
      let newKey: KeyObject;
      try { newKey = createPublicKey(input.publicKeyPem); } catch { return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.pem.invalid', { keyId: input.keyId }) }; }
      const entries = load();
      const maxGeneration = entries.reduce((m, e) => Math.max(m, e.generation), 0);
      if (input.generation <= maxGeneration) {
        return { ok: false, error: configError('MARKET_ROOT_GENERATION_INVALID', 'market.root.generation.invalid', { generation: input.generation, maxGeneration }) };
      }
      if (entries.some(e => e.keyId === input.keyId)) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.duplicate', { keyId: input.keyId }) };
      const authorizer = entries.find(e => e.keyId === input.authorizedByKeyId && e.status === 'active');
      if (!authorizer) return { ok: false, error: configError('MARKET_ROOT_AUTHORIZATION_INVALID', 'market.root.authorizer.missing') };
      let authorizerKey: KeyObject;
      try { authorizerKey = createPublicKey(authorizer.publicKeyPem); } catch { return { ok: false, error: configError('MARKET_ROOT_AUTHORIZATION_INVALID', 'market.root.authorizer.invalid') }; }
      const authorized = verifyRootAuthorization(authorizerKey, {
        keyId: input.keyId, generation: input.generation, publicKeyPem: input.publicKeyPem,
      }, input.authorizedBySignature);
      if (!authorized.ok) return authorized;
      entries.push({
        keyId: input.keyId, publicKeyPem: input.publicKeyPem, generation: input.generation, status: 'active',
        authorizedByKeyId: input.authorizedByKeyId, authorizedBySignature: input.authorizedBySignature, createdAt: now(),
      });
      save(entries);
      void newKey;
      return { ok: true, value: undefined };
    },
    retireRoot(keyId) {
      const entries = load();
      const hit = entries.find(e => e.keyId === keyId);
      if (!hit) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.unknown', { keyId }) };
      hit.status = 'retired';
      save(entries);
      return { ok: true, value: undefined };
    },
    revokeRoot(keyId) {
      const entries = load();
      const hit = entries.find(e => e.keyId === keyId);
      if (!hit) return { ok: false, error: configError('MARKET_KEY_INVALID', 'market.key.unknown', { keyId }) };
      hit.status = 'revoked';
      save(entries);
      return { ok: true, value: undefined };
    },
    activePublicKeys() {
      const keys: KeyObject[] = [];
      for (const entry of load()) {
        if (entry.status !== 'active') continue;
        try { keys.push(createPublicKey(entry.publicKeyPem)); } catch { /* 坏 PEM 跳过（fail-closed 于验证） */ }
      }
      return { ok: true, value: keys };
    },
    get(keyId) {
      return load().find(e => e.keyId === keyId) ?? null;
    },
  };
}
