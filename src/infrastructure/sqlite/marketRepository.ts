// src/infrastructure/sqlite/marketRepository.ts — W5-01 市场持久层（SQLite 单一事实源）
// publish 事务内完成：版本冲突检测 + nonce 持久化 + 审计链追加——任一步失败整体回滚（不半写）。
// 审计哈希链：GENESIS → entry_hash 连续（verifyAuditChain 全链重算——篡改即 MARKET_AUDIT_INTEGRITY_FAILED）。
import type Database from 'better-sqlite3';
import type { OperationResult } from '../../protocol/results.js';
import { gatewayError } from '../../protocol/errors.js';
import { sha256Canonical } from '../../domain/security/approvalGrant.js';
import type { SignedMarketItem } from '../../application/forge/marketSigning.js';

export interface MarketCatalogEntry {
  id: string;
  kind: string;
  version: string;
  publisher: string;
  sha256: string;
  signerKeyId: string;
}

export interface MarketKeyRecord {
  keyId: string;
  publicKeyPem: string;
  generation: number;
  status: 'active' | 'retired' | 'revoked';
  authorizedByKeyId: string | null;
  authorizedBySignature: string | null;
}

export interface MarketRepository {
  publish(item: SignedMarketItem, actor: string, nonce: string, createdAt: string): OperationResult<void>;
  get(id: string): OperationResult<SignedMarketItem>;
  revoke(id: string, actor: string, nonce: string, createdAt: string): OperationResult<void>;
  listCatalog(): MarketCatalogEntry[];
  registerKey(entry: MarketKeyRecord, actor: string, nonce: string, createdAt: string): OperationResult<void>;
  retireKey(keyId: string, actor: string, nonce: string, createdAt: string): OperationResult<void>;
  revokeKey(keyId: string, actor: string, nonce: string, createdAt: string): OperationResult<void>;
  getKeyPem(keyId: string): OperationResult<string>;
  keyRecords(): MarketKeyRecord[];
  consumeNonce(nonce: string, nowMs: number): OperationResult<void>;
  verifyAuditChain(): OperationResult<void>;
}

const fail = (code: string, message: string, messageKey: string): OperationResult<never> =>
  ({ ok: false, error: gatewayError(code, message, messageKey) });

const rowToItem = (row: { id: string; kind: string; version: string; publisher: string; payload_json: string; payload_digest: string; signature: string; signer_key_id: string; expiry: number | null; scope_json: string }): SignedMarketItem => ({
  id: row.id, kind: row.kind as SignedMarketItem['kind'], version: row.version, publisher: row.publisher,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>, payloadDigest: row.payload_digest,
  sha256: row.payload_digest, signature: row.signature, signerKeyId: row.signer_key_id,
  expiry: row.expiry, scope: JSON.parse(row.scope_json) as string[],
});

export function openMarketRepository(db: Database.Database, options: { now?: () => number } = {}): MarketRepository {
  const now = options.now ?? Date.now;

  const appendAudit = (action: string, actor: string, target: string, nonce: string, createdAt: string): void => {
    const last = db.prepare('SELECT entry_hash FROM market_audit ORDER BY sequence DESC LIMIT 1').get() as { entry_hash: string } | undefined;
    const previous = last?.entry_hash ?? 'GENESIS';
    const sequence = (db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM market_audit').get() as { next: number }).next;
    const entryHash = sha256Canonical({ sequence, action, actor, target, nonce, previous, createdAt });
    db.prepare('INSERT INTO market_audit (sequence, action, actor, target, nonce, prev_hash, entry_hash, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sequence, action, actor, target, nonce, previous, entryHash, createdAt);
  };

  const consumeNonce = (nonce: string, nowMs: number): OperationResult<void> => {
    db.prepare('DELETE FROM market_nonces WHERE expires_at <= ?').run(nowMs);
    const exists = db.prepare('SELECT nonce FROM market_nonces WHERE nonce=?').get(nonce);
    if (exists) return fail('MARKET_NONCE_REPLAYED', 'nonce 已使用（重放拒绝）', 'market.nonce.replayed');
    db.prepare('INSERT INTO market_nonces (nonce, expires_at) VALUES (?,?)').run(nonce, nowMs + 5 * 60_000);
    return { ok: true, value: undefined };
  };

  const applyKeyRecord = (entry: MarketKeyRecord): void => {
    db.prepare('INSERT INTO market_keys (key_id, public_pem, generation, status, authorized_by_key_id, authorized_by_signature, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(entry.keyId, entry.publicKeyPem, entry.generation, entry.status, entry.authorizedByKeyId, entry.authorizedBySignature, new Date().toISOString());
  };

  return {
    publish(item, actor, nonce, createdAt) {
      const tx = db.transaction((): OperationResult<void> => {
        const nonceResult = consumeNonce(nonce, now());
        if (!nonceResult.ok) return nonceResult;
        const existing = db.prepare('SELECT id FROM market_items WHERE id=? AND version=?').get(item.id, item.version);
        if (existing) return fail('MARKET_ITEM_VERSION_CONFLICT', `相同 id/version 已存在：${item.id}@${item.version}`, 'market.item.version.conflict');
        db.prepare(`INSERT INTO market_items (id, kind, version, publisher, payload_json, payload_digest, signature, signer_key_id, expiry, scope_json, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)`)
          .run(item.id, item.kind, item.version, item.publisher, JSON.stringify(item.payload), item.payloadDigest, item.signature, item.signerKeyId, item.expiry, JSON.stringify(item.scope), createdAt);
        appendAudit('publish', actor, item.id, nonce, createdAt);
        return { ok: true, value: undefined };
      });
      try { return tx(); } catch (cause) {
        return fail('MARKET_TRANSACTION_FAILED', `发布事务失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'market.transaction.failed');
      }
    },
    get(id) {
      const row = db.prepare("SELECT * FROM market_items WHERE id=? AND status='active' ORDER BY created_at DESC LIMIT 1").get(id) as Parameters<typeof rowToItem>[0] | undefined;
      if (!row) {
        const revoked = db.prepare("SELECT id FROM market_items WHERE id=? AND status='revoked'").get(id);
        return revoked
          ? fail('MARKET_ITEM_REVOKED', '条目已吊销', 'market.item.revoked')
          : fail('MARKET_ITEM_NOT_FOUND', '条目不存在', 'market.item.notFound');
      }
      return { ok: true, value: rowToItem(row) };
    },
    revoke(id, actor, nonce, createdAt) {
      const tx = db.transaction((): OperationResult<void> => {
        const nonceResult = consumeNonce(nonce, now());
        if (!nonceResult.ok) return nonceResult;
        const hit = db.prepare('SELECT id FROM market_items WHERE id=?').get(id);
        if (!hit) return fail('MARKET_ITEM_NOT_FOUND', '条目不存在', 'market.item.notFound');
        db.prepare("UPDATE market_items SET status='revoked' WHERE id=?").run(id);
        appendAudit('revoke', actor, id, nonce, createdAt);
        return { ok: true, value: undefined };
      });
      try { return tx(); } catch (cause) {
        return fail('MARKET_TRANSACTION_FAILED', `吊销事务失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'market.transaction.failed');
      }
    },
    listCatalog() {
      return (db.prepare("SELECT * FROM market_items WHERE status='active' ORDER BY id").all() as Array<Parameters<typeof rowToItem>[0]>)
        .map(row => ({ id: row.id, kind: row.kind, version: row.version, publisher: row.publisher, sha256: row.payload_digest, signerKeyId: row.signer_key_id }));
    },
    registerKey(entry, actor, nonce, createdAt) {
      const tx = db.transaction((): OperationResult<void> => {
        const nonceResult = consumeNonce(nonce, now());
        if (!nonceResult.ok) return nonceResult;
        if (db.prepare('SELECT key_id FROM market_keys WHERE key_id=?').get(entry.keyId)) {
          return fail('MARKET_KEY_INVALID', '密钥已存在', 'market.key.duplicate');
        }
        applyKeyRecord(entry);
        appendAudit('key:register', actor, entry.keyId, nonce, createdAt);
        return { ok: true, value: undefined };
      });
      try { return tx(); } catch (cause) {
        return fail('MARKET_TRANSACTION_FAILED', `密钥注册事务失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'market.transaction.failed');
      }
    },
    retireKey(keyId, actor, nonce, createdAt) {
      const tx = db.transaction((): OperationResult<void> => {
        const nonceResult = consumeNonce(nonce, now());
        if (!nonceResult.ok) return nonceResult;
        const hit = db.prepare('SELECT key_id FROM market_keys WHERE key_id=?').get(keyId);
        if (!hit) return fail('MARKET_KEY_INVALID', '密钥不存在', 'market.key.unknown');
        db.prepare("UPDATE market_keys SET status='retired' WHERE key_id=?").run(keyId);
        appendAudit('key:retire', actor, keyId, nonce, createdAt);
        return { ok: true, value: undefined };
      });
      try { return tx(); } catch (cause) {
        return fail('MARKET_TRANSACTION_FAILED', `密钥退役事务失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'market.transaction.failed');
      }
    },
    revokeKey(keyId, actor, nonce, createdAt) {
      const tx = db.transaction((): OperationResult<void> => {
        const nonceResult = consumeNonce(nonce, now());
        if (!nonceResult.ok) return nonceResult;
        const hit = db.prepare('SELECT key_id FROM market_keys WHERE key_id=?').get(keyId);
        if (!hit) return fail('MARKET_KEY_INVALID', '密钥不存在', 'market.key.unknown');
        db.prepare("UPDATE market_keys SET status='revoked' WHERE key_id=?").run(keyId);
        appendAudit('key:revoke', actor, keyId, nonce, createdAt);
        return { ok: true, value: undefined };
      });
      try { return tx(); } catch (cause) {
        return fail('MARKET_TRANSACTION_FAILED', `密钥吊销事务失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}`, 'market.transaction.failed');
      }
    },
    getKeyPem(keyId) {
      const row = db.prepare('SELECT public_pem FROM market_keys WHERE key_id=?').get(keyId) as { public_pem: string } | undefined;
      return row ? { ok: true, value: row.public_pem } : fail('MARKET_KEY_INVALID', '密钥不存在', 'market.key.unknown');
    },
    keyRecords() {
      return (db.prepare('SELECT * FROM market_keys ORDER BY generation').all() as Array<Record<string, unknown>>)
        .map(row => ({
          keyId: String(row.key_id), publicKeyPem: String(row.public_pem), generation: Number(row.generation),
          status: row.status as MarketKeyRecord['status'],
          authorizedByKeyId: row.authorized_by_key_id as string | null,
          authorizedBySignature: row.authorized_by_signature as string | null,
        }));
    },
    consumeNonce,
    verifyAuditChain() {
      try {
        let previous = 'GENESIS';
        for (const row of db.prepare('SELECT * FROM market_audit ORDER BY sequence').all() as Array<Record<string, string | number>>) {
          const expected = sha256Canonical({ sequence: row.sequence, action: row.action, actor: row.actor, target: row.target, nonce: row.nonce, previous, createdAt: row.created_at });
          if (row.prev_hash !== previous || row.entry_hash !== expected) {
            return fail('MARKET_AUDIT_INTEGRITY_FAILED', '审计哈希链完整性校验失败', 'market.audit.integrity.failed');
          }
          previous = String(row.entry_hash);
        }
        return { ok: true, value: undefined };
      } catch (cause) {
        return fail('MARKET_AUDIT_INTEGRITY_FAILED', `审计链校验异常：${String((cause as Error)?.message ?? cause).slice(0, 120)}`, 'market.audit.integrity.failed');
      }
    },
  };
}
