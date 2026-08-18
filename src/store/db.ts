// src/store/db.ts — L1-1 数据库层（better-sqlite3 + sqlite-vec + FTS5）
// 设计：单库 nodus.db（WAL + foreign_keys）；表：sessions/messages/settings/checkpoints/audit
//  - messages 全量历史永不删（recall 层）；messages_fts FTS5 中文 bigram 检索
//  - archival_vec sqlite-vec 384 维（rowid 对齐 messages.id）；扩展加载失败降级纯 FTS5
//  - audit 审计哈希链（合规红线：prev_hash 连续，可校验篡改）
//  - checkpoints 会话快照（差距补齐 #6：限 10 份）
import { join } from 'node:path';
import { mkdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { migrateMemory } from '../infrastructure/sqlite/memoryMigrations.js';
import { runDbMigrationsTo } from '../migrations/db/runner.js';
// 中文 bigram 预处理（单一实现：legacy messages_fts 与 modern memory_fts 共用）
import { bigramZh } from '../infrastructure/sqlite/bigramZh.js';

// ESM 下加载 CJS 扩展（sqlite-vec 为 CommonJS 包——require 在 ESM 不可用）
const requireCjs = createRequire(import.meta.url);

export type Db = InstanceType<typeof Database>;

const SCHEMA_VERSION = 10; // v7/v8: usage_stats 前缀缓存列（audit §13.43）；v9: sessions.forked_from_id 血缘（audit §13.50）；v10: usage_stats.reasoning_tokens 成本五维（audit §13.56）

export { bigramZh };
// 审计追加已迁至 kernel/audit.ts（分层泄漏修复 audit §13.45）——store 仅再导出（infra→kernel 合法方向）
export { appendAudit, auditHash, type AuditDb } from '../kernel/audit.js';
export { saveCheckpoint } from '../kernel/checkpoint.js';
// supremacy 3.5：searchMessages 再导出移除——db.ts→kernel/memory.js 是内存环 13 的运行时回边
// （memory→memoryRepository→db→memory）。消费方直接从 kernel/memory 导入（分层正确方向）。

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
    -- P1-4 会话级真实授权（approve_for_session，gap 2026-08-18）：用户批准一次 → 本会话内
    -- 同键自动放行（持久化，跨重启生效；与 permissions.json 规则叠加，deny 级联）
    CREATE TABLE IF NOT EXISTS session_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      grant_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'allow' CHECK (kind IN ('allow','deny')),
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, tool, grant_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_grants ON session_grants(session_id, tool);
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
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    -- /cost /usage /status 的会话与区间聚合查询索引（长期高频路径——此前全表扫描）
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_stats(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_stats(ts);
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

  // W1-06：Black Hole Memory 持久层（primary/FTS/outbox/vector）——schema 唯一入口
  migrateMemory(db, { embeddingDimensions: 384 });

  // 迁移基线（W0-06）：registry 驱动 V2 salience / V3 run_no / V4 parts 列演进
  // 每条迁移：checksum 验证 → SQLite 一致备份 → 事务内 expand + 版本提升 + history=applied；
  // 失败 → 事务回滚（版本不提升）+ history=failed，异常向上抛出（不再吞掉）
  runDbMigrationsTo(db, dbFile, SCHEMA_VERSION);

  return db;
}

export function closeDB(db: Db): void {
  try { db.close(); } catch { /* 已关闭 */ }
}

// ── 产品 API ──────────────────────────────────────────────

// 会话 checkpoint：保存快照（每会话限 10 份，超限删最旧）

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
