// src/kernel/checkpoint.ts — 会话 checkpoint 保存（kernel 自有端口——store 层 re-export，audit §13.45）
// 方向修复：agent 不再动态 import store 的 saveCheckpoint（kernel→存储层跨层）。
// A-07 快照增量化（kimi _checkpoint 对标）：消息只增不删（软删 archived=1 不删行），
// 快照存 messagesUpTo 上界代替全量复制——重建 = id<=上界 查询，精确且省空间（每回合不再 SELECT 全量）。
import type { DbPort } from './dbPort.js';

/** 保存快照（每会话限 10 份，超限删最旧；返回行 id） */
export function saveCheckpoint(db: DbPort, sessionId: string, data: unknown): number {
  const last = db.prepare(`SELECT id FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sessionId) as { id: number } | undefined;
  const r = db.prepare(`INSERT INTO checkpoints (session_id, data, ts, prev_id) VALUES (?,?,?,?)`)
    .run(sessionId, JSON.stringify(data), Date.now(), last?.id ?? null);
  const MAX = 10;
  db.prepare(`
    DELETE FROM checkpoints WHERE session_id=? AND id NOT IN (
      SELECT id FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT ?
    )
  `).run(sessionId, sessionId, MAX);
  return Number(r.lastInsertRowid);
}

/** 增量快照数据（A-07）：当前会话消息 id 上界 + 条数——替代全量 messages 复制 */
export function snapshotMessagesUpTo(db: DbPort, sessionId: string): { messagesUpTo: number; count: number } {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m, COUNT(*) AS c FROM messages WHERE session_id=?`).get(sessionId) as { m: number; c: number };
  return { messagesUpTo: row.m, count: row.c };
}

export interface CheckpointMessageRow { id: number; role: string; content: string; tool_call_id: string | null; archived: number; ts: number }

/** 从快照数据取消息行（新形态 messagesUpTo 重建 / 旧形态 messages 数组直取——向后兼容）；数据不完整 → null */
export function messagesAtCheckpoint(db: DbPort, sessionId: string, data: any): CheckpointMessageRow[] | null {
  if (Array.isArray(data?.messages)) return data.messages as CheckpointMessageRow[];
  if (typeof data?.messagesUpTo === 'number') {
    return db.prepare(
      `SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? AND id<=? ORDER BY id`
    ).all(sessionId, data.messagesUpTo as number) as CheckpointMessageRow[];
  }
  return null;
}
