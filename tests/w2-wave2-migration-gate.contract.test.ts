import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runWave2MigrationDrill } from '../scripts/wave2Migration.mjs';
import { runWave2Gates } from '../scripts/wave2GateRunner.mjs';

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

describe('W2-11 Wave 2 migration and release gate', () => {
  it('runs upgrade, new write, rollback, re-upgrade in the exact order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxnodus-w2-11-'));
    try {
      const report = runWave2MigrationDrill(join(dir, 'drill.db'));
      expect(report.ok).toBe(true);
      expect(report.sequence).toEqual(['upgrade', 'new write', 'rollback', 're-upgrade']);
      expect(report.newWriteTable).toBe('autonomy_records');
      expect(report.legacyTasksReadable).toBe(true);
      expect(report.finalSchemaVersion).toBe(2);
      expect(report.evidenceIds).toHaveLength(4);
      const db = new Database(join(dir, 'drill.db'), { readonly: true });
      expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='autonomy_records'").get() as {name:string}|undefined)?.name).toBe('autonomy_records');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()).toBeTruthy();
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed when a new autonomy write is attempted in legacy tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxnodus-w2-11-legacy-'));
    try {
      const dbPath = join(dir, 'legacy.db');
      const report = runWave2MigrationDrill(dbPath);
      expect(report.ok).toBe(true);
      const db = new Database(dbPath);
      // 护栏触发器：legacy tasks 拒绝新写入（新写只能进 autonomy_records）
      expect(() => db.prepare('INSERT INTO tasks(id,goal) VALUES(?,?)').run('g1', 'must be autonomy record')).toThrow();
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires exact per-task scripts and non-empty W2 contract suites', () => {
    for (const [task, suite] of Object.entries({
      'test:w2-01':'tests/w2-config-onboarding.contract.test.ts', 'test:w2-02':'tests/w2-personalization.contract.test.ts',
      'test:w2-03':'tests/w2-capability-registry.contract.test.ts', 'test:w2-04':'tests/w2-extension-scope.contract.test.ts',
      'test:w2-05':'tests/w2-session-lifecycle-hooks.contract.test.ts', 'test:w2-06':'tests/w2-mcp-duplex.contract.test.ts',
      'test:w2-07':'tests/w2-skill-lifecycle.contract.test.ts', 'test:w2-08':'tests/w2-plugin-sandbox.contract.test.ts',
      'test:w2-09':'tests/w2-autonomy-persistence-budget.contract.test.ts', 'test:w2-10':'tests/w2-subagent-recovery-progress.contract.test.ts',
      'test:w2-11':'tests/w2-wave2-migration-gate.contract.test.ts',
    })) { expect(scripts[task]).toBe(`vitest run ${suite}`); }
    expect(scripts['migration:drill:wave2']).toBe('node scripts/run-wave2-migration-drill.mjs');
    expect(scripts['gate:wave2']).toBe('node scripts/run-wave2-gates.mjs');
  });

  it('gate reports stable unavailable for undelivered runtime surfaces', () => {
    const report = runWave2Gates({ rootDir: process.cwd(), migration: {
      ok:true, sequence:['upgrade','new write','rollback','re-upgrade'], finalSchemaVersion:2,
      evidenceIds:['e1','e2','e3','e4'], legacyTasksReadable:true, newWriteTable:'autonomy_records',
    }});
    expect(report.ok).toBe(true);
    expect(report.unavailable).toEqual({ computer:'CAPABILITY_UNAVAILABLE', forge:'CAPABILITY_UNAVAILABLE' });
  });
});
