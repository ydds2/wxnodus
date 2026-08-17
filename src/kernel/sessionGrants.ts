// src/kernel/sessionGrants.ts — approve_for_session 真实会话授权（gap P1-4 落地，2026-08-18）
// 参考：kimi approval.py approve_for_session（按 action 名会话授权）/ gemini Always-Allow
// 分层（授权优先级置于模式判定之上、红线之下）——机制参考、实现原创。
// 语义：用户批准一次 → 本会话内同键自动放行（持久化 DB，跨重启生效，会话隔离）。
// 键构造（安全方向）：bash = 精确命令串；fs_write/fs_edit = 精确 path；其余 = 规范化 JSON。
// （execpolicy 式首词前缀规则是 P2-3 未做项——此处刻意不前缀化：批准 `git` 前缀会连带放行
// `git push --force`，违背「授权粒度诚实」原则。）
// 优先级（agent 内生效顺序）：红线 reject > 规则 deny > 会话 deny > 会话 allow > 模式判定。
import type Database from 'better-sqlite3';
type Db = InstanceType<typeof Database>;

export function grantKey(tool: string, args: Record<string, any>): string {
  if (tool === 'bash') return String(args?.command ?? '').trim();
  if (tool === 'fs_write' || tool === 'fs_edit') return String(args?.path ?? '').trim();
  // 参数键排序规范化——同语义不同顺序不重复授权
  return JSON.stringify(Object.fromEntries(Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b))));
}

export interface SessionGrantRow {
  id: number;
  sessionId: string;
  tool: string;
  key: string;
  kind: 'allow' | 'deny';
  createdAt: number;
}

/** 查询本会话命中：deny 优先于 allow（同键先 deny 后 allow 以最新为准） */
export function checkSessionGrant(db: Db, sessionId: string, tool: string, args: Record<string, any>): 'allow' | 'deny' | null {
  const key = grantKey(tool, args);
  if (!key) return null;
  const row = db.prepare(`SELECT kind FROM session_grants WHERE session_id=? AND tool=? AND grant_key=? ORDER BY id DESC LIMIT 1`)
    .get(sessionId, tool, key) as { kind: string } | undefined;
  return row ? (row.kind as 'allow' | 'deny') : null;
}

/** 记录授权（批准后自动 allow；deny 经 /perm session-deny 显式记录） */
export function grantSession(db: Db, sessionId: string, tool: string, args: Record<string, any>, kind: 'allow' | 'deny'): void {
  const key = grantKey(tool, args);
  if (!key) return;
  db.prepare(`INSERT INTO session_grants (session_id, tool, grant_key, kind, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(session_id, tool, grant_key) DO UPDATE SET kind=excluded.kind, created_at=excluded.created_at`)
    .run(sessionId, tool, key, kind, Date.now());
}

/** 撤销（按 tool + 可选键；缺省清本会话全部授权） */
export function revokeSessionGrant(db: Db, sessionId: string, tool?: string, key?: string): number {
  const r = tool
    ? (key
      ? db.prepare(`DELETE FROM session_grants WHERE session_id=? AND tool=? AND grant_key=?`).run(sessionId, tool, key)
      : db.prepare(`DELETE FROM session_grants WHERE session_id=? AND tool=?`).run(sessionId, tool))
    : db.prepare(`DELETE FROM session_grants WHERE session_id=?`).run(sessionId);
  return r.changes;
}

export function listSessionGrants(db: Db, sessionId: string): SessionGrantRow[] {
  return (db.prepare(`SELECT id, session_id, tool, grant_key, kind, created_at FROM session_grants WHERE session_id=? ORDER BY id DESC LIMIT 100`)
    .all(sessionId) as Array<{ id: number; session_id: string; tool: string; grant_key: string; kind: string; created_at: number }>)
    .map(r => ({ id: r.id, sessionId: r.session_id, tool: r.tool, key: r.grant_key, kind: r.kind as 'allow' | 'deny', createdAt: r.created_at }));
}
