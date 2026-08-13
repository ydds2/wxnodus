// src/presentation/http/httpTokenStore.ts — Bearer token 存储（只存 SHA-256 哈希，支持宽限轮换/即时撤销）
import { createHash, timingSafeEqual } from 'node:crypto';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface HttpTokenInput {
  id: string;
  subject: string;
  secret: string;
  notBefore: string;
  expiresAt: string;
}

interface TokenRecord extends Omit<HttpTokenInput, 'secret'> {
  hash: Buffer;
  revokedAt?: string;
  retireAt?: string;
}

export interface VerifiedToken {
  id: string;
  subject: string;
}

const digest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();

export function createHttpTokenStore(initial: HttpTokenInput[]) {
  const records = new Map(initial.map(input => [input.id, { ...input, secret: undefined, hash: digest(input.secret) } as TokenRecord]));

  return {
    verify(secret: string, nowMs: number): OperationResult<VerifiedToken> {
      const hash = digest(secret);
      const record = [...records.values()].find(item => timingSafeEqual(item.hash, hash));
      if (!record) return err(gatewayError('HTTP_TOKEN_INVALID', 'Bearer token 无效', 'http.token.invalid'));
      if (record.revokedAt && nowMs >= Date.parse(record.revokedAt)) {
        return err(gatewayError('HTTP_TOKEN_REVOKED', 'Bearer token 已撤销', 'http.token.revoked'));
      }
      if (nowMs < Date.parse(record.notBefore) || nowMs >= Date.parse(record.retireAt ?? record.expiresAt)) {
        return err(gatewayError('HTTP_TOKEN_EXPIRED', 'Bearer token 不在有效期', 'http.token.expired'));
      }
      return ok({ id: record.id, subject: record.subject });
    },
    rotate(subject: string, next: HttpTokenInput, graceUntil: string) {
      for (const record of records.values()) {
        if (record.subject === subject && !record.revokedAt) record.retireAt = graceUntil;
      }
      records.set(next.id, { ...next, secret: undefined, hash: digest(next.secret) } as TokenRecord);
    },
    revoke(id: string, revokedAt: string) {
      const record = records.get(id);
      if (record) record.revokedAt = revokedAt;
    },
  };
}

export type HttpTokenStore = ReturnType<typeof createHttpTokenStore>;
