import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { closeDB, openDB } from '../src/store/db.js';
import { dbMigrations } from '../src/migrations/db/registry.js';
import { getSchemaVersion, runDbMigrationsTo } from '../src/migrations/db/runner.js';

const fixturePath = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/db/v3-schema.sql',
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database schema history', () => {
  it('aligns schema_version with the extracted V2-V12 migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-db-migration-'));
    dirs.push(dir);
    const seed = new Database(join(dir, 'nodus.db'));
    seed.exec(readFileSync(fixturePath, 'utf8'));
    seed.close();

    const db = openDB(dir);
    const fixture = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string };
    const history = db.prepare(
      "SELECT COUNT(*) AS count FROM migration_history WHERE status='applied'",
    ).get() as { count: number };

    expect(Number(fixture.value), 'DB_SCHEMA_VERSION_DRIFT').toBe(12);
    expect(history.count).toBeGreaterThanOrEqual(7);
    const columns = db.prepare('PRAGMA table_info(serve_session_ownership)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual(['session_id', 'principal_id', 'is_default', 'claimed_at']);
    expect(columns.some(column => /token/i.test(column.name))).toBe(false);
    db.prepare('INSERT INTO serve_session_ownership(session_id, principal_id, is_default, claimed_at) VALUES (?, ?, 1, ?)')
      .run('owned-session', 'principal:a', Date.now());
    expect(() => db.prepare('UPDATE serve_session_ownership SET principal_id=? WHERE session_id=?')
      .run('principal:b', 'owned-session')).toThrow('SERVE_SESSION_OWNERSHIP_IMMUTABLE');
    expect(() => db.prepare('UPDATE serve_session_ownership SET session_id=? WHERE session_id=?')
      .run('renamed-session', 'owned-session')).toThrow('SERVE_SESSION_OWNERSHIP_IMMUTABLE');
    expect(() => db.prepare('UPDATE serve_session_ownership SET claimed_at=? WHERE session_id=?')
      .run(Date.now() + 1, 'owned-session')).toThrow('SERVE_SESSION_OWNERSHIP_IMMUTABLE');
    expect(() => db.prepare('DELETE FROM serve_session_ownership WHERE session_id=?')
      .run('owned-session')).toThrow('SERVE_SESSION_OWNERSHIP_DELETE_DENIED');
    expect(() => db.prepare('INSERT OR REPLACE INTO serve_session_ownership(session_id, principal_id, is_default, claimed_at) VALUES (?, ?, 1, ?)')
      .run('owned-session', 'principal:b', Date.now() + 1)).toThrow('SERVE_SESSION_OWNERSHIP_DELETE_DENIED');
    expect(() => db.prepare('UPDATE serve_session_ownership SET is_default=0 WHERE session_id=?')
      .run('owned-session')).not.toThrow();
    closeDB(db);
  });

  it('creates V11 ownership schema only through the migration transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-db-v11-order-'));
    dirs.push(dir);
    const dbPath = join(dir, 'nodus.db');
    const db = new Database(dbPath);
    db.exec(readFileSync(fixturePath, 'utf8'));
    db.exec(`
      ALTER TABLE usage_stats ADD COLUMN cache_hit_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_stats ADD COLUMN cache_miss_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_stats ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN forked_from_id TEXT;
      INSERT INTO settings(key, value) VALUES ('schema_version', '10');
    `);

    expect(getSchemaVersion(db)).toBe(10);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='serve_session_ownership'").get()).toBeUndefined();

    const outcomes = runDbMigrationsTo(db, dbPath, 11);
    expect(outcomes).toHaveLength(1);
    expect(getSchemaVersion(db)).toBe(11);
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name='serve_session_ownership'").get()).toEqual({ type: 'table' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='serve_session_ownership' ORDER BY name").all())
      .toEqual([
        { name: 'serve_session_ownership_delete_denied' },
        { name: 'serve_session_ownership_immutable' },
      ]);
    db.close();
  });

  it('rolls V11 schema creation back when migration validation fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-db-v11-rollback-'));
    dirs.push(dir);
    const dbPath = join(dir, 'nodus.db');
    const db = new Database(dbPath);
    db.exec(readFileSync(fixturePath, 'utf8'));
    db.prepare("INSERT INTO settings(key, value) VALUES ('schema_version', '10')").run();
    const migration = dbMigrations().find(item => item.toVersion === 11)!;
    expect(migration.strategy).toBe('forward-only');
    if (migration.strategy !== 'forward-only') throw new Error('V11_MIGRATION_STRATEGY_INVALID');
    const failing = {
      ...migration,
      validate: (_state: InstanceType<typeof Database>) => { throw new Error('validation failed'); },
    };

    expect(() => db.transaction(() => {
      failing.expand(db);
      failing.validate(db);
    })()).toThrow('validation failed');
    expect(getSchemaVersion(db)).toBe(10);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='serve_session_ownership'").get()).toBeUndefined();
    db.close();
  });
});
