// src/application/forge/marketSigning.ts — W5-01 canonical 签名封套
// 签名覆盖 id/kind/version/publisher/payloadDigest/expiry/scope 全部字段（排序键 canonical JSON）；
// payload 经 payloadDigest 绑定（sha256 over canonical JSON）；Ed25519 签名 + 过期检查。
// 篡改任一字段 → MARKET_SIGNATURE_INVALID；过期（签名有效也拒）→ MARKET_ITEM_EXPIRED。
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export type MarketItemKind = 'mcp-server' | 'skill' | 'recipe';

/** canonical 封套（签名字段白名单——排序键后序列化，任何字段进出都会破坏签名） */
export interface MarketEnvelope {
  id: string;
  kind: MarketItemKind;
  version: string;
  publisher: string;
  payloadDigest: string;
  expiry: number | null; // epoch ms；null=不过期
  scope: string[]; // 分发范围声明（如 ['public']）
}

export interface SignedMarketItem extends MarketEnvelope {
  payload: Record<string, unknown>;
  /** payloadDigest 别名（历史字段兼容） */
  sha256: string;
  signature: string; // base64 Ed25519 over canonical(envelope)
  signerKeyId: string;
}

export interface SigningKeypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

/** 排序键 canonical JSON（跨进程确定性——签名/验签共享同一字节流） */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const payloadDigestOf = (payload: Record<string, unknown>): string =>
  createHash('sha256').update(canonicalJson(payload)).digest('hex');

const envelopeCanonical = (envelope: MarketEnvelope): string => canonicalJson(envelope);

export const signEnvelope = (keypair: SigningKeypair, envelope: MarketEnvelope): string =>
  sign(null, Buffer.from(envelopeCanonical(envelope), 'utf8'), keypair.privateKey).toString('base64');

export function signMarketItem(
  keypair: SigningKeypair,
  input: { id: string; kind: MarketItemKind; version: string; publisher: string; payload: Record<string, unknown>; expiry: number | null; scope: string[] },
): SignedMarketItem {
  const payloadDigest = payloadDigestOf(input.payload);
  const envelope: MarketEnvelope = {
    id: input.id, kind: input.kind, version: input.version, publisher: input.publisher,
    payloadDigest, expiry: input.expiry, scope: input.scope,
  };
  return { ...envelope, payload: input.payload, sha256: payloadDigest, signature: signEnvelope(keypair, envelope), signerKeyId: keypair.keyId };
}

export function verifyMarketItem(publicKey: KeyObject, item: SignedMarketItem): OperationResult<SignedMarketItem> {
  // 1) 载荷摘要重算绑定（payload 篡改检测）
  if (!/^[a-f0-9]{64}$/.test(item.payloadDigest) || payloadDigestOf(item.payload) !== item.payloadDigest) {
    return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.item.tampered') };
  }
  // 2) canonical 封套签名验证
  try {
    const envelope: MarketEnvelope = {
      id: item.id, kind: item.kind, version: item.version, publisher: item.publisher,
      payloadDigest: item.payloadDigest, expiry: item.expiry, scope: item.scope,
    };
    const valid = verify(null, Buffer.from(envelopeCanonical(envelope), 'utf8'), publicKey, Buffer.from(item.signature, 'base64'));
    if (!valid) return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.signature.invalid') };
  } catch {
    return { ok: false, error: configError('MARKET_SIGNATURE_INVALID', 'market.signature.malformed') };
  }
  // 3) 过期检查（签名有效但已过期 → 拒收）
  if (typeof item.expiry === 'number' && item.expiry <= Date.now()) {
    return { ok: false, error: configError('MARKET_ITEM_EXPIRED', 'market.item.expired', { id: item.id }) };
  }
  return { ok: true, value: item };
}

export interface RootAuthorization {
  keyId: string;
  generation: number;
  publicKeyPem: string;
}

/** 根轮换授权：旧 active 根对新根（keyId/generation/publicKeyPem）签名——canonical 机制复用 */
export function signRootAuthorization(keypair: SigningKeypair, authorization: RootAuthorization): string {
  return sign(null, Buffer.from(canonicalJson(authorization), 'utf8'), keypair.privateKey).toString('base64');
}

export function verifyRootAuthorization(publicKey: KeyObject, authorization: RootAuthorization, signature: string): OperationResult<void> {
  try {
    const valid = verify(null, Buffer.from(canonicalJson(authorization), 'utf8'), publicKey, Buffer.from(signature, 'base64'));
    return valid
      ? { ok: true, value: undefined }
      : { ok: false, error: configError('MARKET_ROOT_AUTHORIZATION_INVALID', 'market.root.authorization.invalid') };
  } catch {
    return { ok: false, error: configError('MARKET_ROOT_AUTHORIZATION_INVALID', 'market.root.authorization.malformed') };
  }
}

export function createSigningKeypair(keyId: string): SigningKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId };
}
