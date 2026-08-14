// src/infrastructure/sqlite/memoryMigrations.ts — Black Hole Memory 持久层 schema（primary/FTS/outbox/vector 单一事实源）
import type { Db } from '../../store/db.js';
import { bigramZh } from './bigramZh.js';

export function migrateMemory(db: Db, options: { embeddingDimensions: number }): void {
  // 中文 bigram 预处理函数（SQLite 自定义函数，每次连接注册；与 legacy messages_fts 同实现）
  db.function('bigram_zh', { deterministic: true }, (s: unknown) => bigramZh(String(s ?? '')));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,scope_tier TEXT NOT NULL,scope_key TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,generation INTEGER NOT NULL,embedding_state TEXT NOT NULL,salience REAL NOT NULL,provenance_json TEXT NOT NULL,source_trust REAL NOT NULL,retention_class TEXT NOT NULL,retain_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,dedup_count INTEGER NOT NULL DEFAULT 1,tombstoned_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_dedup_active ON memory_records(scope_tier,scope_key,role,content_hash) WHERE tombstoned_at IS NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED,scope_tier UNINDEXED,scope_key UNINDEXED,content,tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS embedding_jobs(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(record_id,generation));
    CREATE INDEX IF NOT EXISTS ix_embedding_claim ON embedding_jobs(state,available_at,lease_until,created_at);
    CREATE TABLE IF NOT EXISTS embedding_dead_letter(job_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,generation INTEGER NOT NULL,error_code TEXT NOT NULL,attempts INTEGER NOT NULL,failed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_vectors(record_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,embedding_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // one-time 回填：早期库 memory_fts 存的是原文（unicode61 中文检索退化）——
  // 换成 bigram 预处理后一次性重建（marker 幂等，绝不重复回填）
  const marker = db.prepare(`SELECT value FROM memory_schema_meta WHERE key='fts_bigram_v1'`).get() as { value: string } | undefined;
  if (!marker) {
    db.exec(`
      DELETE FROM memory_fts;
      INSERT INTO memory_fts(record_id, scope_tier, scope_key, content)
        SELECT id, scope_tier, scope_key, bigram_zh(content) FROM memory_records WHERE tombstoned_at IS NULL;
    `);
    db.prepare(`INSERT INTO memory_schema_meta(key, value) VALUES ('fts_bigram_v1', ?)`).run(new Date().toISOString());
  }
  try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${options.embeddingDimensions}]);`); } catch { /* exact JSON fallback */ }
}
