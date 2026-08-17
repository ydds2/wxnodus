import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { closeDB, openDB } from '../src/store/db.js';

const fixturePath = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/db/v3-schema.sql',
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database schema history', () => {
  it('aligns schema_version with the extracted V2-V8 migrations', () => {
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

    expect(Number(fixture.value), 'DB_SCHEMA_VERSION_DRIFT').toBe(8);
    expect(history.count).toBeGreaterThanOrEqual(5);
    closeDB(db);
  });
});
