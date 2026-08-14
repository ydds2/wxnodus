// src/application/forge/marketPolicy.ts — W5-01 市场管理端点策略
// Bearer token 仅存 sha256 哈希（明文绝不落盘）；timingSafeEqual 比较；按 action 校验 scope；
// nonce 一次性（TTL 集，重放 → MARKET_NONCE_REPLAYED）；body 字节上限由调用方经 maxBodyBytes 执行。
import { createHash, timingSafeEqual } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { gatewayError } from '../../protocol/errors.js';

export type MarketAction = 'keys:register' | 'keys:rotate' | 'publish' | 'revoke';

export interface MarketAdminToken {
  id: string;
  scope: MarketAction[];
  sha256: string; // 明文 token 的 sha256 hex——绝不存明文
}

export interface MarketPolicy {
  readonly maxBodyBytes: number;
  authorize(input: { authorization?: string; nonce?: string; action: MarketAction }): OperationResult<{ actor: string }>;
}

export const tokenSha256 = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export function createMarketPolicy(options: {
  tokens: MarketAdminToken[];
  nonceTtlMs: number;
  maxBodyBytes: number;
  now?: () => number;
}): MarketPolicy {
  const now = options.now ?? Date.now;
  const seenNonces = new Map<string, number>(); // nonce → expiresAt
  return {
    maxBodyBytes: options.maxBodyBytes,
    authorize(input) {
      // 1) Bearer 解析 + 哈希匹配（timingSafeEqual）
      const match = /^Bearer (.+)$/.exec(input.authorization ?? '');
      if (!match) return { ok: false, error: gatewayError('MARKET_UNAUTHORIZED', '缺少 Bearer token', 'market.unauthorized') };
      const presented = tokenSha256(match[1]!.trim());
      const token = options.tokens.find(t => safeEqual(t.sha256, presented));
      if (!token) return { ok: false, error: gatewayError('MARKET_UNAUTHORIZED', 'token 无效', 'market.unauthorized') };
      // 2) scope
      if (!token.scope.includes(input.action)) {
        return { ok: false, error: gatewayError('MARKET_FORBIDDEN', `token 无权执行 ${input.action}`, 'market.forbidden') };
      }
      // 3) nonce 一次性（防重放）
      if (!input.nonce || !/^[A-Za-z0-9._-]{1,128}$/.test(input.nonce)) {
        return { ok: false, error: gatewayError('MARKET_NONCE_INVALID', 'nonce 缺失或非法', 'market.nonce.invalid') };
      }
      const ts = now();
      for (const [nonce, expiresAt] of seenNonces) if (expiresAt <= ts) seenNonces.delete(nonce); // 惰性过期清理
      if (seenNonces.has(input.nonce)) {
        return { ok: false, error: gatewayError('MARKET_NONCE_REPLAYED', 'nonce 已使用（重放拒绝）', 'market.nonce.replayed') };
      }
      seenNonces.set(input.nonce, ts + options.nonceTtlMs);
      return { ok: true, value: { actor: token.id } };
    },
  };
}
