// src/kernel/memoryInbox.ts — AI 记忆收件箱（波 2 ⑪，gemini .inbox 对标）
// 语义：settings.memoryInbox=true 时 memory_write 先进收件箱（pending），人审
// /memory inbox apply 批准生效（写入 modern 记忆层）/ discard 丢弃 / undo 按记录撤销——
// 堵「不可控记忆」评审攻击（可审可退）。默认关（memory_write 直写零漂移）。
// 表为惰性自建（IF NOT EXISTS，memory 层同款模式——不占版本迁移注册表）。
export interface InboxDb {
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
}

export type InboxStatus = 'pending' | 'applied' | 'discarded' | 'reverted';

export interface InboxRow {
  id: string;
  session_id: string;
  content: string;
  status: InboxStatus;
  memory_record_id: string | null;
  ts: number;
}

const COLUMNS = 'id, session_id, content, status, memory_record_id, ts';

export function ensureMemoryInbox(db: InboxDb): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS memory_inbox(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', memory_record_id TEXT, ts INTEGER NOT NULL)`,
  ).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS ix_memory_inbox_sess ON memory_inbox(session_id, ts)`).run();
}

const rowOf = (r: Record<string, unknown> | undefined): InboxRow | null => {
  if (!r) return null;
  return {
    id: String(r.id),
    session_id: String(r.session_id),
    content: String(r.content),
    status: r.status as InboxStatus,
    memory_record_id: r.memory_record_id === null ? null : String(r.memory_record_id),
    ts: Number(r.ts),
  };
};

/** 记忆入箱（pending）→ 行（id 供审阅命令面引用） */
export function inboxAdd(db: InboxDb, sessionId: string, content: string, id: string, now: number): InboxRow {
  ensureMemoryInbox(db);
  db.prepare(`INSERT INTO memory_inbox(${COLUMNS}) VALUES (?,?,?,'pending',NULL,?)`).run(id, sessionId, content, now);
  return rowOf(db.prepare(`SELECT ${COLUMNS} FROM memory_inbox WHERE id=?`).get(id) as Record<string, unknown> | undefined)!;
}

/** 审阅列表（status 缺省 pending；ts 降序） */
export function inboxList(db: InboxDb, sessionId: string, status?: InboxStatus): InboxRow[] {
  ensureMemoryInbox(db);
  const rows = status
    ? db.prepare(`SELECT ${COLUMNS} FROM memory_inbox WHERE session_id=? AND status=? ORDER BY ts DESC LIMIT 50`).all(sessionId, status)
    : db.prepare(`SELECT ${COLUMNS} FROM memory_inbox WHERE session_id=? ORDER BY ts DESC LIMIT 50`).all(sessionId);
  return rows.map(r => rowOf(r as Record<string, unknown>)!).filter(Boolean);
}

/** 状态流转（apply/discard/revert）；applied 时记 memory_record_id（供 undo 定位） */
export function inboxMark(db: InboxDb, id: string, status: InboxStatus, memoryRecordId?: string): boolean {
  ensureMemoryInbox(db);
  const r = db.prepare(
    memoryRecordId
      ? `UPDATE memory_inbox SET status=?, memory_record_id=? WHERE id=?`
      : `UPDATE memory_inbox SET status=? WHERE id=?`,
  );
  const res = (memoryRecordId ? r.run(status, memoryRecordId, id) : r.run(status, id)) as { changes: number };
  return (res.changes ?? 0) > 0;
}

/** 取单行（undo 定位已生效记录） */
export function inboxGet(db: InboxDb, id: string): InboxRow | null {
  ensureMemoryInbox(db);
  return rowOf(db.prepare(`SELECT ${COLUMNS} FROM memory_inbox WHERE id=?`).get(id) as Record<string, unknown> | undefined);
}
