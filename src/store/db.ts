// src/store/db.ts — L1-1 数据库层（better-sqlite3 + sqlite-vec + FTS5）
// 设计：单库 nodus.db（WAL + foreign_keys）；表：sessions/messages/settings/checkpoints/audit
//  - messages 全量历史永不删（recall 层）；messages_fts FTS5 中文 bigram 检索
//  - archival_vec sqlite-vec 384 维（rowid 对齐 messages.id）；扩展加载失败降级纯 FTS5
//  - audit 审计哈希链（合规红线：prev_hash 连续，可校验篡改）
//  - checkpoints 会话快照（差距补齐 #6：限 10 份）
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

export type Db = InstanceType<typeof Database>;

const SCHEMA_VERSION = 1;

// 中文 bigram 预处理：FTS5 unicode61 无法切中文词——按 2 字滑窗生成 bigram 空格串
// 例：「黑洞引擎」→「黑洞 洞引 引擎」——检索「黑洞」可命中；英文/数字连续段保留为单词
export function bigramZh(text: string): string {
  const tokens: string[] = [];
  let buf = '';
  let word = '';
  const flushWord = () => { if (word) { tokens.push(word); word = ''; } };
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      flushWord();
      buf += ch;
      if (buf.length >= 2) { tokens.push(buf); buf = buf.slice(1); }
    } else if (/[a-zA-Z0-9_]/.test(ch)) {
      buf = '';
      word += ch;
    } else {
      buf = '';
      flushWord();
      if (ch.trim()) tokens.push(ch);
    }
  }
  flushWord();
  return tokens.join(' ');
}

// 审计哈希：SHA-256 链（prev_hash + event + payload + ts）
export function auditHash(prev: string, event: string, payload: string, ts: number): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(`${prev}|${event}|${payload}|${ts}`).digest('hex');
}

export function openDB(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'nodus.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL,
      tool_call_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL,
      prev_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ckpt_session ON checkpoints(session_id, ts);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prev_hash TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      hash TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);

  // FTS5 消息全文索引（content='' 外部内容表，rowid 对齐 messages.id）
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, tokenize = 'unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, bigram_zh(new.content));
      END;
    `);
    // bigram 转换函数注册（SQLite 自定义函数）
    db.function('bigram_zh', { deterministic: true }, (s: unknown) => bigramZh(String(s ?? '')));
  } catch {
    // FTS5 不可用时降级：搜索走 LIKE（功能降级不阻断）
  }

  // sqlite-vec 向量扩展（容错：加载失败仅无向量检索，纯 FTS5 兜底）
  try {
    const vec = require('sqlite-vec') as { load(db: InstanceType<typeof Database>): void };
    vec.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS archival_vec USING vec0(
        id INTEGER PRIMARY KEY,
        embedding float[384]
      );
    `);
  } catch {
    // vec 不可用：降级
  }

  // 幂等迁移 + schema_version
  const ver = db.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get() as any;
  if (!ver) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }

  return db;
}

export function closeDB(db: Db): void {
  try { db.close(); } catch { /* 已关闭 */ }
}

// ── 产品 API ──────────────────────────────────────────────

// 审计追加（合规红线）：自动计算 SHA-256 链哈希，prev_hash 取末条
export function appendAudit(db: Db, event: string, payload: unknown): number {
  const last = db.prepare(`SELECT hash FROM audit ORDER BY id DESC LIMIT 1`).get() as { hash: string } | undefined;
  const prev = last?.hash ?? 'GENESIS';
  const ts = Date.now();
  const p = JSON.stringify(payload ?? {});
  const hash = auditHash(prev, event, p, ts);
  const r = db.prepare(`INSERT INTO audit (prev_hash, event, payload, hash, ts) VALUES (?,?,?,?,?)`)
    .run(prev, event, p, hash, ts);
  return Number(r.lastInsertRowid);
}

// 会话 checkpoint：保存快照（每会话限 10 份，超限删最旧）
export function saveCheckpoint(db: Db, sessionId: string, data: unknown): number {
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

export function restoreCheckpoint<T = unknown>(db: Db, sessionId: string): T | null {
  const row = db.prepare(`SELECT data FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sessionId) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as T : null;
}

// 全文搜索（FTS5）：查询词经 bigram 转换后 OR 展开，命中返回消息行
export function searchMessages(db: Db, query: string, opts: { limit?: number; sessionId?: string } = {}): Array<{ id: number; session_id: string; role: string; content: string; ts: number }> {
  const limit = opts.limit ?? 10;
  try {
    const terms = bigramZh(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const where = opts.sessionId ? `AND m.session_id = @sid` : '';
    return db.prepare(`
      SELECT m.id, m.session_id, m.role, m.content, m.ts
      FROM messages m JOIN messages_fts f ON f.rowid = m.id
      WHERE messages_fts MATCH @match ${where}
      ORDER BY rank LIMIT @limit
    `).all({ match, sid: opts.sessionId, limit }) as any[];
  } catch {
    // FTS 不可用降级：LIKE 模糊
    return db.prepare(`
      SELECT id, session_id, role, content, ts FROM messages
      WHERE content LIKE @q ${opts.sessionId ? `AND session_id = @sid` : ''}
      ORDER BY id DESC LIMIT @limit
    `).all({ q: `%${query}%`, sid: opts.sessionId, limit }) as any[];
  }
}
