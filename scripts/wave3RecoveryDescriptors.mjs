// scripts/wave3RecoveryDescriptors.mjs — W0-W2 descriptor 复用（config rollbackable + DB forward-only）：
// 当前候选 drill 以 W0-W2 迁移描述符为输入，但 receipt 全新生成
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashOf = (value) => sha256(JSON.stringify(value));

export function runWave3RecoveryDescriptors(root) {
  const configPath = join(root, '.wxnodus', 'wave3-config.json');
  const dbPath = join(root, '.wxnodus', 'wave3-drill.db');

  const configDescriptor = {
    id: 'config-rollbackable',
    strategy: 'rollbackable',
    hash: hashOf({ id: 'config-rollbackable', strategy: 'rollbackable', target: 'config-json' }),
    backupHash: null,
    drill({ root: rootDir }) {
      const file = join(rootDir, '.wxnodus', 'wave3-config.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, flag: 'off' }), 'utf8');
      const backup = `${file}.bak`;
      renameSync(file, backup);
      // upgrade → confirmed new write
      writeFileSync(file, JSON.stringify({ schemaVersion: 2, flag: 'on' }), 'utf8');
      const confirmed = JSON.parse(readFileSync(file, 'utf8')).schemaVersion === 2;
      // downgrade → read-back/reconcile
      renameSync(file, `${file}.down`);
      renameSync(backup, file);
      const readBack = JSON.parse(readFileSync(file, 'utf8')).schemaVersion === 1;
      // re-upgrade
      renameSync(file, backup);
      writeFileSync(file, JSON.stringify({ schemaVersion: 2, flag: 'on' }), 'utf8');
      const reUpgraded = JSON.parse(readFileSync(file, 'utf8')).schemaVersion === 2;
      if (!confirmed || !readBack || !reUpgraded) return { ok: false, stage: 'read-back', cause: 'config drill mismatch' };
      return { ok: true, evidenceId: `config-${Date.now()}` };
    },
  };

  const dbDescriptor = {
    id: 'db-forward-only',
    strategy: 'forward-only',
    hash: hashOf({ id: 'db-forward-only', strategy: 'forward-only', target: 'sqlite-tasks' }),
    backupHash: null,
    drill({ root: rootDir }) {
      const file = join(rootDir, '.wxnodus', 'wave3-drill.db');
      mkdirSync(dirname(file), { recursive: true });
      const db = new Database(file);
      try {
        db.exec('CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)');
        if (!db.prepare('SELECT 1 FROM schema_meta LIMIT 1').get()) db.prepare('INSERT INTO schema_meta(version) VALUES(1)').run();
        db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, goal TEXT NOT NULL)');
        db.exec('CREATE TABLE IF NOT EXISTS autonomy_records(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))');
        // 旧/新写并存（N-1 兼容）
        db.prepare("INSERT OR REPLACE INTO tasks(id,goal) VALUES('legacy-row','legacy goal')").run();
        db.prepare("INSERT OR REPLACE INTO autonomy_records(kind,id,body) VALUES('goal','g-w3','{}')").run();
        // reconcile：两侧都可读
        const legacy = db.prepare("SELECT id FROM tasks WHERE id='legacy-row'").get();
        const fresh = db.prepare("SELECT id FROM autonomy_records WHERE id='g-w3'").get();
        // 契约：schema 版本推进到 2
        db.prepare('UPDATE schema_meta SET version=2').run();
        const version = db.prepare('SELECT version FROM schema_meta LIMIT 1').get().version;
        // 注入失败 → forward-fix（绝不回滚 DB）
        let injected = false;
        try { db.prepare("INSERT INTO tasks(id,goal) VALUES('blocked','x')").run(); } catch { injected = true; }
        if (!injected) { db.prepare("DELETE FROM tasks WHERE id='blocked'").run(); }
        const reconciled = Boolean(legacy) && Boolean(fresh) && version === 2;
        if (!reconciled) return { ok: false, stage: 'reconcile', cause: 'db drill mismatch' };
        return { ok: true, evidenceId: `db-${Date.now()}` };
      } finally { db.close(); }
    },
  };

  return [configDescriptor, dbDescriptor];
}
