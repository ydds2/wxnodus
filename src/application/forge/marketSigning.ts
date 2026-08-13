// src/application/forge/marketSigning.ts — 市场签名分发最小版（蓝图 §5.3.3）：Ed25519 签名/验签（payload 自包含、篡改即 MARKET_SIGNATURE_INVALID）
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export interface MarketItem { id: string; kind: 'mcp-server' | 'skill' | 'recipe'; payload: Record<string, unknown>; sha256: string }
export interface SignedMarketItem extends MarketItem { signature: string; signerKeyId: string }

export const itemSha256 = (item: Omit<MarketItem, 'sha256'>): string =>
  createHash('sha256').update(JSON.stringify(item)).digest('hex');

export interface SigningKeypair { privateKey: KeyObject; publicKey: KeyObject; keyId: string }

export function createSigningKeypair(keyId: string): SigningKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId };
}

export function signMarketItem(keypair: SigningKeypair, item: Omit<MarketItem, 'sha256'>): SignedMarketItem {
  const sha256 = itemSha256(item);
  const signature = sign(null, Buffer.from(sha256, 'hex'), keypair.privateKey).toString('base64');
  return { ...item, sha256, signature, signerKeyId: keypair.keyId };
}

export function verifyMarketItem(publicKey: KeyObject, item: SignedMarketItem): OperationResult<MarketItem> {
  // 1) 载荷哈希绑定（篡改检测）
  const recomputed = itemSha256({ id: item.id, kind: item.kind, payload: item.payload });
  if (recomputed !== item.sha256 || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.item.tampered') };
  }
  // 2) 签名验证（Ed25519 over sha256）
  try {
    const valid = verify(null, Buffer.from(item.sha256, 'hex'), publicKey, Buffer.from(item.signature, 'base64'));
    if (!valid) return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.signature.invalid') };
  } catch {
    return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.signature.malformed') };
  }
  return { ok: true, value: { id: item.id, kind: item.kind, payload: item.payload, sha256: item.sha256 } };
}
