-- tests/fixtures/db/v3-schema.sql — V3 主 schema fixture（与 src/store/db.ts 及 src/compat/schemaSurface.ts 同源）
-- W0-02 冻结：sessions/messages/settings/checkpoints/audit/tasks/usage_stats/flow_runs/cron_jobs
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
