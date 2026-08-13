// src/infrastructure/sqlite/memoryMigrations.ts — Black Hole Memory 持久层 schema（primary/FTS/outbox/vector 单一事实源）
import type { Db } from '../../store/db.js';

export function migrateMemory(db: Db, options: { embeddingDimensions: number }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,scope_tier TEXT NOT NULL,scope_key TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,generation INTEGER NOT NULL,embedding_state TEXT NOT NULL,salience REAL NOT NULL,provenance_json TEXT NOT NULL,source_trust REAL NOT NULL,retention_class TEXT NOT NULL,retain_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,dedup_count INTEGER NOT NULL DEFAULT 1,tombstoned_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_dedup_active ON memory_records(scope_tier,scope_key,role,content_hash) WHERE tombstoned_at IS NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED,scope_tier UNINDEXED,scope_key UNINDEXED,content,tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS embedding_jobs(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(record_id,generation));
    CREATE INDEX IF NOT EXISTS ix_embedding_claim ON embedding_jobs(state,available_at,lease_until,created_at);
    CREATE TABLE IF NOT EXISTS embedding_dead_letter(job_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,generation INTEGER NOT NULL,error_code TEXT NOT NULL,attempts INTEGER NOT NULL,failed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_vectors(record_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,embedding_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
  `);
  try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${options.embeddingDimensions}]);`); } catch { /* exact JSON fallback */ }
}
