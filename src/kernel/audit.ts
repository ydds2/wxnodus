// src/kernel/audit.ts — 审计追加（kernel 自有端口——store 层 re-export，audit §13.45 分层泄漏修复）
// 方向修复：此前 kernel（agent/balance）直 import store/db 的 appendAudit（kernel→存储层跨层）；
// 现在 kernel 拥有审计追加语义与 SQL，store 仅作为再导出点（infrastructure→kernel 合法方向）。
import { createHash } from 'node:crypto';

/** 审计最小结构端口（真实 Db 自然满足） */
export type AuditDb = {
  prepare(sql: string): {
    get(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown[];
    run(...a: unknown[]): { lastInsertRowid: number | bigint };
  };
  /** V4 P3-6（B-5）：readback 回填 hash 的单事务（better-sqlite3 事务签名） */
  transaction<T>(op: (...args: unknown[]) => T): (...args: unknown[]) => T;
};

export function auditHash(prev: string, event: string, payload: string, ts: number): string {
  return createHash('sha256').update(`${prev}|${event}|${payload}|${ts}`).digest('hex');
}

/** 追加审计事件（哈希链：prev_hash → hash；返回行 id）。失败由调用方决定语义（多数场景静默）。
 * V4 P3-6（B-5）：SELECT prev + INSERT 两语句 autocommit 无事务——两进程（CLI+VSCode 扩展）
 * 共享 dataDir 时各读同一 prev 后先后插入 → 链分叉。改单语句 INSERT...SELECT COALESCE
 * （原子取链尾），进程内 db 串行保证并发安全。 */
export function appendAudit(db: AuditDb, event: string, payload: unknown): number {
  const ts = Date.now();
  const p = JSON.stringify(payload ?? {});
  // 先原子插入（prev 经子查询取链尾，找不到用 GENESIS）；再读回本行 hash 供返回 id
  const r = db.prepare(`
    INSERT INTO audit (prev_hash, event, payload, hash, ts)
    SELECT COALESCE((SELECT hash FROM audit ORDER BY id DESC LIMIT 1), 'GENESIS'), ?, ?, '', ?
  `).run(event, p, ts);
  const id = Number(r.lastInsertRowid);
  // 回填 hash（prev 取本行实际插入时的链尾——单事务 readback）
  db.transaction(() => {
    const row = db.prepare(`SELECT prev_hash FROM audit WHERE id=?`).get(id) as { prev_hash: string } | undefined;
    const hash = auditHash(row?.prev_hash ?? 'GENESIS', event, p, ts);
    db.prepare(`UPDATE audit SET hash=? WHERE id=?`).run(hash, id);
  })();
  return id;
}

/** V4 P3-6（B-5）：审计哈希链校验器（此前全仓无 audit 表校验——「可校验篡改」属性静默失效） */
export function verifyAudit(db: AuditDb): { ok: true; count: number } | { ok: false; brokenAtId: number } {
  const rows = db.prepare(`SELECT id, prev_hash, event, payload, hash, ts FROM audit ORDER BY id`).all() as Array<{ id: number; prev_hash: string; event: string; payload: string; hash: string; ts: number }>;
  let prev = 'GENESIS';
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, brokenAtId: row.id };
    if (auditHash(row.prev_hash, row.event, row.payload, row.ts) !== row.hash) return { ok: false, brokenAtId: row.id };
    prev = row.hash;
  }
  return { ok: true, count: rows.length };
}
