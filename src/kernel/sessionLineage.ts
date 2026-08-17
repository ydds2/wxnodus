// src/kernel/sessionLineage.ts — 会话血缘与结构化列表（gap P2-1 部分落地，2026-08-18）
// 参考：codex protocol.rs forked_from_id（fork 记血缘）/ gemini sessionUtils.ts:90-121
// （列表带 first_user_message 摘要）——机制参考、实现原创（SQL 归 kernel 拥有，
// store 仅建表；/sessions 与桌面端 serve 网关共用同一结构化出口，单一事实源）。
import type Database from 'better-sqlite3';
type Db = InstanceType<typeof Database>;

export interface StructuredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  msgCount: number;
  /** 首条用户消息摘要（≤80 字，无则空串）——列表预览用（gemini first_user_message 对齐） */
  firstUser: string;
  /** 分支来源会话 id（/fork 记血缘）；null = 非分支 */
  forkedFromId: string | null;
  /** 直接分支数（孩子数） */
  forkCount: number;
}

/** 结构化会话列表（新→旧），每会话附消息数/首问摘要/血缘——命令层与桌面网关共用 */
export function listSessionsStructured(db: Db, limit = 100): StructuredSession[] {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.created_at, s.updated_at, s.forked_from_id,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
      (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND TRIM(m.content) <> '' ORDER BY m.id LIMIT 1) AS first_user,
      (SELECT COUNT(*) FROM sessions c WHERE c.forked_from_id = s.id) AS fork_count
    FROM sessions s
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; title: string; created_at: number; updated_at: number; forked_from_id: string | null;
    msg_count: number; first_user: string | null; fork_count: number;
  }>;
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    msgCount: r.msg_count,
    firstUser: (r.first_user ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    forkedFromId: r.forked_from_id,
    forkCount: r.fork_count,
  }));
}

/** fork 会话：复制全部消息 + 记血缘（forked_from_id=source）——返回新会话 id */
export function forkSession(db: Db, sourceId: string, newId: string): { ok: boolean; error?: string; msgCount: number } {
  const n = (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id=?`).get(sourceId) as { c: number }).c;
  if (!n) return { ok: false, error: `会话不存在：${sourceId}`, msgCount: 0 };
  const src = db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sourceId) as { title: string } | undefined;
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at, forked_from_id) VALUES (?,?,?,?,?)`)
    .run(newId, `${src?.title || sourceId} (fork)`, now, now, sourceId);
  db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_call_id, archived, ts)
    SELECT ?, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=?
  `).run(newId, sourceId);
  const msgCount = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`).get(newId) as { c: number }).c;
  return { ok: true, msgCount };
}

/** 血缘链（祖先链，含自身，旧→新）——/fork lineage 与桌面端历史树共用 */
export function sessionLineage(db: Db, sessionId: string, maxDepth = 20): string[] {
  const chain: string[] = [];
  let cur: string | null = sessionId;
  const seen = new Set<string>();
  while (cur && chain.length < maxDepth && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    const row = db.prepare(`SELECT forked_from_id FROM sessions WHERE id=?`).get(cur) as { forked_from_id: string | null } | undefined;
    cur = row?.forked_from_id ?? null;
  }
  return chain;
}
