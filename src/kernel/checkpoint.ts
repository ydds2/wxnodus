// src/kernel/checkpoint.ts — 会话 checkpoint 保存（kernel 自有端口——store 层 re-export，audit §13.45）
// 方向修复：agent 不再动态 import store 的 saveCheckpoint（kernel→存储层跨层）。
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
