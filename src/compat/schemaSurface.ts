// src/compat/schemaSurface.ts — SQLite schema 面冻结（src/store/db.ts 主 schema 的事实记录）
// 与 tests/fixtures/db/v3-schema.sql 保持同一枚举；SCHEMA_VERSION=1 与结构漂移诚实记录，不伪装已迁移。
import { entry } from './descriptors.js';
import type { CompatibilityEntry } from './schema.js';

const TABLES: Record<string, string[]> = {
  sessions: ['id', 'title', 'created_at', 'updated_at'],
  messages: ['id', 'session_id', 'role', 'content', 'tool_call_id', 'archived', 'ts', 'salience', 'run_no', 'parts'],
  settings: ['key', 'value'],
  checkpoints: ['id', 'session_id', 'data', 'ts', 'prev_id'],
  audit: ['id', 'prev_hash', 'event', 'payload', 'hash', 'ts'],
  tasks: ['id', 'goal', 'status', 'output', 'created_at', 'done_at', 'parent_id', 'kind', 'pid', 'exit_code', 'log_file', 'retries', 'timeout_ms', 'tags', 'cwd', 'started_at', 'error'],
  usage_stats: ['id', 'session_id', 'model', 'input_tokens', 'output_tokens', 'ts'],
  flow_runs: ['id', 'skill', 'nodes', 'current', 'finished', 'ts'],
  cron_jobs: ['id', 'schedule', 'action', 'last_run', 'enabled'],
};

export function schemaSurface(): CompatibilityEntry[] {
  const out: CompatibilityEntry[] = [];

  for (const [table, columns] of Object.entries(TABLES)) {
    out.push(entry('schema', `table:${table}`, { columns }));
  }

  out.push(entry('schema', 'file', { name: 'nodus.db', journal: 'WAL', foreignKeys: 'ON' }));
  out.push(entry('schema', 'optional-extension', { fts5: 'optional', sqliteVec: 'optional', fallback: 'LIKE' }));
  // 结构已演进到内联 V4 列，但 schema_version 仍可能为 1——漂移事实必须暴露，不得写成已迁移
  out.push(entry('schema', 'schema-version-drift', { storedValue: 1, inlineEvolution: ['V2', 'V3', 'V4'] }, 'deprecate', {
    reasonCode: 'false_success',
    replacement: '正式 migration registry（Wave 0 W0-06）',
  }));
  out.push(entry('schema', 'migration-error-handling', { behavior: 'ALTER failure swallowed as duplicate column' }, 'deprecate', {
    reasonCode: 'false_success',
    replacement: '失败显式记录 history=failed 且版本不提升',
  }));

  return out;
}
