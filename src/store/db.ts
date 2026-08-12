// src/store/db.ts — L1-1 数据库层（better-sqlite3 + sqlite-vec + FTS5）
// 设计：单库 nodus.db（WAL + foreign_keys）；表：sessions/messages/settings/checkpoints/audit
//  - messages 全量历史永不删（recall 层）；messages_fts FTS5 中文 bigram 检索
//  - archival_vec sqlite-vec 384 维（rowid 对齐 messages.id）；扩展加载失败降级纯 FTS5
//  - audit 审计哈希链（合规红线：prev_hash 连续，可校验篡改）
//  - checkpoints 会话快照（差距补齐 #6：限 10 份）
import { join } from 'node:path';
import { mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

// ESM 下加载 CJS 扩展（sqlite-vec 为 CommonJS 包——require 在 ESM 不可用）
const requireCjs = createRequire(import.meta.url);

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
  return createHash('sha256').update(`${prev}|${event}|${payload}|${ts}`).digest('hex');
}

export function openDB(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const dbFile = join(dataDir, 'nodus.db');
  const db = new Database(dbFile);

  // 旧版库检测：settings 表存在但结构非 V3（key/value）→ 旧版本遗留库
  // 处理：备份为 nodus-legacy-<ts>.db 后重建（绝不破坏用户数据，仅移出活动路径）
  const settingsCols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
  if (settingsCols.length > 0 && !settingsCols.some(c => c.name === 'value')) {
    try { db.close(); } catch { /* 忽略 */ }
    const legacy = join(dataDir, `nodus-legacy-${Date.now()}.db`);
    try { renameSync(dbFile, legacy); } catch { /* 备份失败仍继续 */ }
    return openDB(dataDir); // 重建
  }

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
      ts INTEGER NOT NULL,
      salience REAL NOT NULL DEFAULT 1.0,
      run_no INTEGER NOT NULL DEFAULT 0,
      parts TEXT
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
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      done_at INTEGER,
      parent_id TEXT DEFAULT '',
      kind TEXT DEFAULT 'agent',
      pid INTEGER,
      exit_code INTEGER,
      log_file TEXT DEFAULT '',
      retries INTEGER DEFAULT 0,
      timeout_ms INTEGER DEFAULT 600000,
      tags TEXT DEFAULT '',
      cwd TEXT DEFAULT '',
      started_at INTEGER,
      error TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill TEXT NOT NULL,
      nodes TEXT NOT NULL,
      current INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule TEXT NOT NULL,
      action TEXT NOT NULL,
      last_run INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);

  // tasks 表迁移（V3 并行任务系统：旧库 tasks 无新列 → ALTER 补齐，绝不丢数据）
  try {
    const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    const have = new Set(taskCols.map(c => c.name));
    const ADD: Array<[string, string]> = [
      ['parent_id', `TEXT DEFAULT ''`],
      ['kind', `TEXT DEFAULT 'agent'`],
      ['pid', 'INTEGER'],
      ['exit_code', 'INTEGER'],
      ['log_file', `TEXT DEFAULT ''`],
      ['retries', 'INTEGER DEFAULT 0'],
      ['timeout_ms', 'INTEGER DEFAULT 600000'],
      ['tags', `TEXT DEFAULT ''`],
      ['cwd', `TEXT DEFAULT ''`],
      ['started_at', 'INTEGER'],
      ['error', `TEXT DEFAULT ''`],
    ];
    for (const [col, def] of ADD) {
      if (!have.has(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at)`);
  } catch { /* 迁移失败不阻断（新库已含全列） */ }

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
    const vec = requireCjs('sqlite-vec') as { load(db: InstanceType<typeof Database>): void };
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
  // V2：messages.salience（记忆置顶/淡化）——旧库无此列，ALTER 补列（幂等：已存在即跳过）
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN salience REAL NOT NULL DEFAULT 1.0`);
  } catch {
    // 列已存在（新库建表已含）——忽略
  }
  // V3（架构）：messages.run_no——用户轮次（压缩/undo 跨压缩寻址用；旧库补列默认 0，
  // 新消息写入时递增）
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN run_no INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在——忽略
  }
  // V4（架构）：messages.parts——消息分段结构（OpenCode parts 模型渐进对齐）：
  // JSON 数组 [{kind:'text'|'tool'|'reasoning', ...}]——工具输出截断/错误/推理分 part；
  // 空（NULL）表示整段即 content（旧数据兼容，查询主源不变）
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN parts TEXT`);
  } catch {
    // 列已存在——忽略
  }
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

export interface SnapshotMessage {
  id?: number;
  role: string;
  content: string;
  tool_call_id?: string | null;
  archived?: number;
  ts?: number;
}

/**
 * A25：以快照消息替换会话消息（/checkpoint restore /rewind /rollback.restore 共用）。
 * 此前各处手写 DELETE+重插——AUTOINCREMENT 的 sqlite_sequence 与 FTS5 触发器
 * messages_ai（AFTER INSERT 同步 messages_fts）会导致重插同 rowid 时
 * 「constraint failed」：DELETE messages 不清理 FTS 行，重插撞 FTS UNIQUE。
 * 统一修复：先删 FTS 旧行 + 重置 sequence，再按快照重插（保留原始 id/ts/archived）。
 */
export function replaceSessionMessages(db: Db, sessionId: string, messages: SnapshotMessage[]): number {
  const oldIds = (db.prepare(`SELECT id FROM messages WHERE session_id=?`).all(sessionId) as Array<{ id: number }>).map(r => r.id);
  db.prepare(`DELETE FROM messages WHERE session_id=?`).run(sessionId);
  // FTS5 清理旧行（触发器只 AFTER INSERT——DELETE 不会自动清 FTS）
  try {
    if (oldIds.length) {
      db.prepare(`DELETE FROM messages_fts WHERE rowid IN (${oldIds.map(() => '?').join(',')})`).run(...oldIds);
    }
    // AUTOINCREMENT 序列重置——让快照原始 id 可恢复
    db.prepare(`DELETE FROM sqlite_sequence WHERE name='messages'`).run();
  } catch { /* FTS/序列不可用：降级重插 */ }
  const ins = db.prepare(`INSERT INTO messages (id, session_id, role, content, tool_call_id, archived, ts) VALUES (?,?,?,?,?,?,?)`);
  const now = Date.now();
  messages.forEach((m, i) => {
    const rawId = Number(m.id);
    const mid = Number.isInteger(rawId) && rawId > 0 ? rawId : undefined;
    ins.run(mid ?? null, sessionId, m.role, String(m.content ?? ''), m.tool_call_id ?? null, m.archived === 1 ? 1 : 0, Number(m.ts) || now + i);
  });
  return messages.length;
}

// 会话 fork：复制会话（含全部消息）到新会话——分支会话不回写源
// 自动恢复候选：最后一条非 system 消息是 user（回合未完成）的最新会话——null 则无
export function pickResumeSession(db: Db): string | null {
  const row = db.prepare(`
    SELECT s.id FROM sessions s
    WHERE EXISTS (
      SELECT 1 FROM messages m WHERE m.session_id = s.id
        AND m.id = (SELECT MAX(id) FROM messages WHERE session_id = s.id AND role != 'system')
        AND m.role = 'user'
    )
    ORDER BY s.updated_at DESC LIMIT 1
  `).get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function forkSession(db: Db, srcId: string, newId: string, titleSuffix = ' (fork)'): number {
  const src = db.prepare(`SELECT title, created_at FROM sessions WHERE id=?`).get(srcId) as { title: string; created_at: number } | undefined;
  if (!src) return 0;
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
    .run(newId, `${src.title || srcId}${titleSuffix}`, now, now);
  db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_call_id, archived, ts)
    SELECT ?, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=?
  `).run(newId, srcId);
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`).get(newId) as { c: number }).c);
}

// 全文搜索（FTS5）：查询词经 bigram 转换后 OR 展开，命中返回消息行
// A21：since 参数（ts >= since 的时间过滤——/memory search|list --since）
export function searchMessages(db: Db, query: string, opts: { limit?: number; sessionId?: string; since?: number } = {}): Array<{ id: number; session_id: string; role: string; content: string; ts: number; salience: number }> {
  const limit = opts.limit ?? 10;
  try {
    const terms = bigramZh(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const where = [
      opts.sessionId ? `AND m.session_id = @sid` : '',
      opts.since ? `AND m.ts >= @since` : '',
    ].join(' ');
    return db.prepare(`
      SELECT m.id, m.session_id, m.role, m.content, m.ts, m.salience
      FROM messages m JOIN messages_fts f ON f.rowid = m.id
      WHERE messages_fts MATCH @match ${where}
      ORDER BY rank LIMIT @limit
    `).all({ match, sid: opts.sessionId, since: opts.since, limit }) as any[];
  } catch {
    // FTS 不可用降级：LIKE 模糊
    return db.prepare(`
      SELECT id, session_id, role, content, ts, salience FROM messages
      WHERE content LIKE @q ${opts.sessionId ? `AND session_id = @sid` : ''} ${opts.since ? `AND ts >= @since` : ''}
      ORDER BY id DESC LIMIT @limit
    `).all({ q: `%${query}%`, sid: opts.sessionId, since: opts.since, limit }) as any[];
  }
}

/** A21：物理删除消息（FTS 外部内容表随行删除自动同步；向量索引手动清）。 */
export function deleteMessage(db: Db, id: number): boolean {
  try {
    db.prepare(`DELETE FROM archival_vec WHERE id=?`).run(id);
  } catch { /* 向量表缺失忽略 */ }
  const r = db.prepare(`DELETE FROM messages WHERE id=?`).run(id);
  return r.changes > 0;
}

/** P0-2：改写消息内容（记忆纠错/更新）。FTS 触发器只覆盖 INSERT——UPDATE 需手动同步；
 * 向量索引清除旧向量（语义已变，避免旧向量误召回；重嵌由后续写入自然补充）。 */
export function updateMessage(db: Db, id: number, content: string): boolean {
  const r = db.prepare(`UPDATE messages SET content=?, ts=? WHERE id=?`).run(content, Date.now(), id);
  if (r.changes === 0) return false;
  try {
    db.prepare(`DELETE FROM messages_fts WHERE rowid=?`).run(id);
    db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`).run(id, bigramZh(content));
  } catch { /* FTS 不可用忽略（LIKE 降级） */ }
  try {
    db.prepare(`DELETE FROM archival_vec WHERE id=?`).run(id);
  } catch { /* 向量表缺失忽略 */ }
  return true;
}
