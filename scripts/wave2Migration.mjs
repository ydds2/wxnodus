// scripts/wave2Migration.mjs — Wave 2 versioned rollbackable 迁移演练：upgrade → new write → rollback → re-upgrade
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const evidence = step => `${step}:${randomUUID()}`;
const reportStep = (step, schemaVersion, evidenceId, extra = {}) => ({ ok:true, step, schemaVersion, evidenceId, ...extra });

function ensureLegacy(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)');
  if (!db.prepare('SELECT 1 FROM schema_meta LIMIT 1').get()) db.prepare('INSERT INTO schema_meta(version) VALUES(1)').run();
  db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, goal TEXT NOT NULL)');
  // 边界护栏：legacy tasks 拒绝新写入（新写只能进 autonomy_records）
  db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_new_write_block BEFORE INSERT ON tasks
    BEGIN SELECT RAISE(ABORT, 'autonomy writes must go to autonomy_records'); END;`);
}
function version(db) { return Number(db.prepare('SELECT version FROM schema_meta LIMIT 1').get().version); }
function upgrade(db) {
  db.exec('CREATE TABLE IF NOT EXISTS autonomy_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id))');
  db.prepare('UPDATE schema_meta SET version=2').run();
}
function writeNew(db) {
  const body = JSON.stringify({ id:'g-drill', objective:'migration proof', acceptanceCriteria:['gate'], createdAt:'2026-08-13T00:00:00.000Z' });
  db.prepare("INSERT INTO autonomy_records(kind,id,body) VALUES('goal','g-drill',?)").run(body);
}
function rollback(db) {
  db.exec('DROP TABLE autonomy_records');
  db.prepare('UPDATE schema_meta SET version=1').run();
}

export function runWave2MigrationDrill(dbPath) {
  const db = new Database(dbPath);
  try {
    ensureLegacy(db);
    const sequence = [], evidenceIds = [];
    upgrade(db); sequence.push('upgrade'); evidenceIds.push(evidence('upgrade'));
    writeNew(db); sequence.push('new write'); evidenceIds.push(evidence('new-write'));
    const wrote = db.prepare("SELECT id FROM autonomy_records WHERE kind='goal' AND id='g-drill'").get();
    rollback(db); sequence.push('rollback'); evidenceIds.push(evidence('rollback'));
    const legacyTasksReadable = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()) && version(db) === 1;
    upgrade(db); sequence.push('re-upgrade'); evidenceIds.push(evidence('re-upgrade'));
    return { ...reportStep('re-upgrade', version(db), evidenceIds[3]), ok:Boolean(wrote) && sequence.join(' → ') === 'upgrade → new write → rollback → re-upgrade',
      sequence, evidenceIds, newWriteTable:'autonomy_records', legacyTasksReadable, finalSchemaVersion:version(db) };
  } finally { db.close(); }
}
