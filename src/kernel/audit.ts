// src/kernel/audit.ts — 审计追加（kernel 自有端口——store 层 re-export，audit §13.45 分层泄漏修复）
// 方向修复：此前 kernel（agent/balance）直 import store/db 的 appendAudit（kernel→存储层跨层）；
// 现在 kernel 拥有审计追加语义与 SQL，store 仅作为再导出点（infrastructure→kernel 合法方向）。
import { createHash } from 'node:crypto';

/** 审计最小结构端口（真实 Db 自然满足） */
export type AuditDb = {
  prepare(sql: string): {
    get(...a: unknown[]): unknown;
    run(...a: unknown[]): { lastInsertRowid: number | bigint };
  };
};

export function auditHash(prev: string, event: string, payload: string, ts: number): string {
  return createHash('sha256').update(`${prev}|${event}|${payload}|${ts}`).digest('hex');
}

/** 追加审计事件（哈希链：prev_hash → hash；返回行 id）。失败由调用方决定语义（多数场景静默）。 */
export function appendAudit(db: AuditDb, event: string, payload: unknown): number {
  const last = db.prepare(`SELECT hash FROM audit ORDER BY id DESC LIMIT 1`).get() as { hash: string } | undefined;
  const prev = last?.hash ?? 'GENESIS';
  const ts = Date.now();
  const p = JSON.stringify(payload ?? {});
  const hash = auditHash(prev, event, p, ts);
  const r = db.prepare(`INSERT INTO audit (prev_hash, event, payload, hash, ts) VALUES (?,?,?,?,?)`)
    .run(prev, event, p, hash, ts);
  return Number(r.lastInsertRowid);
}
