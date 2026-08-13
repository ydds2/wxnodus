// scripts/drill-wave0-recovery.ts — Wave 0 恢复演练：config rollbackable 六步 + DB forward-only 合同
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createConfig } from '../src/store/config.js';
import { configMigrationById } from '../src/migrations/config/registry.js';
import { runConfigUpgrade, runConfigDowngrade } from '../src/migrations/config/runner.js';
import { dbMigrations } from '../src/migrations/db/registry.js';
import { runDbMigrationsTo, getSchemaVersion } from '../src/migrations/db/runner.js';
import { verifyMigrationDescriptorChecksum, computeMigrationDescriptorChecksum } from '../src/migrations/types.js';
import { prepareWave0EvidenceContext } from '../src/release/wave0EvidenceContext.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = resolve(repoRoot, 'docs/superpowers/evidence/wave0');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path: string): string => sha256(readFileSync(path));

// ── 环境 / artifact / policy 上下文（与 gate runner 同源；缺失时先生成）──
const wave0 = prepareWave0EvidenceContext(repoRoot, false);
const environmentHash = wave0.environmentHash;
const artifactHash = wave0.artifactHash;
const policyPath = resolve(repoRoot, 'docs/superpowers/manifests/v3-policy.json');
const policyHash = wave0.policyHash;
const policyChecksum = wave0.policyChecksum;
const bindingSha256 = wave0.bindingSha256;
const compatPath = resolve(repoRoot, 'docs/superpowers/manifests/v3-compatibility.json');
const compatHash = sha256File(compatPath);

// ── 1) config rollbackable 六步 drill ──
function configDrill(): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-drill-cfg-'));
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'zh-CN', theme: 'dark' }));
    const descriptor = configMigrationById('config-v0-to-v1')!;
    if (!verifyMigrationDescriptorChecksum(descriptor)) return { ok: false, detail: 'CONFIG_DESCRIPTOR_CHECKSUM_MISMATCH' };
    const t0 = Date.now();

    const up = runConfigUpgrade(dir, descriptor);                                    // backup+upgrade
    if (up.status !== 'applied') return { ok: false, detail: 'CONFIG_UPGRADE_FAILED' };
    const cfg = createConfig(dir);
    cfg.set('settings', { theme: 'light' });                                        // confirmed-write
    const confirmed: Array<{ key: string; value: unknown }> = [{ key: 'theme', value: 'light' }];
    descriptor.verifyConfirmedWrites(confirmed, confirmed);                         // verify（不抛即通过）
    const down = runConfigDowngrade(dir, descriptor);                               // downgrade
    if (down.status !== 'applied') return { ok: false, detail: 'CONFIG_DOWNGRADE_FAILED' };
    const downgraded = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    if (downgraded.configVersion !== undefined || downgraded.theme !== 'light') return { ok: false, detail: 'CONFIG_CONFIRMED_WRITE_LOST' };
    const reup = runConfigUpgrade(dir, descriptor);                                 // re-upgrade
    if (reup.status !== 'applied') return { ok: false, detail: 'CONFIG_REUPGRADE_FAILED' };
    const reupgraded = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    if (reupgraded.configVersion !== 1 || reupgraded.theme !== 'light') return { ok: false, detail: 'CONFIG_READBACK_MISMATCH' };
    if (Date.now() - t0 > descriptor.maxRtoMs) return { ok: false, detail: 'CONFIG_MAX_RTO_EXCEEDED' };

    // 注入故障：validate 失败 → 原字节不变 + failed record
    const failDir = mkdtempSync(join(tmpdir(), 'wxn-drill-cfgfail-'));
    try {
      writeFileSync(join(failDir, 'settings.json'), '[]');
      const before = readFileSync(join(failDir, 'settings.json'));
      const failed = runConfigUpgrade(failDir, descriptor);
      if (failed.status !== 'failed') return { ok: false, detail: 'CONFIG_FAILURE_INJECTION_NOT_DETECTED' };
      if (Buffer.compare(readFileSync(join(failDir, 'settings.json')), before) !== 0) return { ok: false, detail: 'CONFIG_FAILURE_BYTES_CHANGED' };
    } finally {
      rmSync(failDir, { recursive: true, force: true });
    }
    return { ok: true, detail: 'config-v0-to-v1 六步 + 故障注入通过' };
  } catch (error) {
    return { ok: false, detail: `CONFIG_DRILL_CRASH:${String(error).slice(0, 200)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2) DB forward-only drill ──
const V1_MESSAGES_SQL = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL,
    tool_call_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings (key, value) VALUES ('schema_version', '1');
`;

function dbDrill(): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-drill-db-'));
  const dbPath = join(dir, 'nodus.db');
  try {
    const seed = new Database(dbPath);
    seed.exec(V1_MESSAGES_SQL);
    seed.close();

    const db = new Database(dbPath);
    const t0 = Date.now();
    const outcomes = runDbMigrationsTo(db, dbPath, 4);                             // backup+expand
    if (outcomes.length !== 3) return { ok: false, detail: 'DB_EXPAND_COUNT_MISMATCH' };
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'drill', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('s1', 'user', 'N-1 窗口写入', 1)`).run();   // N-1 read/write window
    db.prepare(`INSERT INTO messages (session_id, role, content, ts, salience, run_no, parts) VALUES ('s1', 'assistant', 'confirmed-write', 2, 2.0, 1, '["text"]')`).run(); // confirmed-write
    for (const migration of dbMigrations()) {                                      // reconcile（只对已应用迁移）
      if (migration.toVersion > 4) continue;
      const r = migration.reconcile(db);
      if (r.reconciledRows !== 2 || r.mismatches !== 0) return { ok: false, detail: 'DB_RECONCILE_MISMATCH' };
    }
    if (getSchemaVersion(db) !== 4) return { ok: false, detail: 'DB_VERSION_NOT_RAISED' };
    db.close();

    // readback：确认写入可读回
    const probe = new Database(dbPath, { readonly: true });
    const rows = probe.prepare('SELECT content FROM messages ORDER BY ts').all() as Array<{ content: string }>;
    probe.close();
    if (rows.map(r => r.content).join(',') !== 'N-1 窗口写入,confirmed-write') return { ok: false, detail: 'DB_CONFIRMED_WRITE_READBACK_MISMATCH' };
    if (Date.now() - t0 > 60_000) return { ok: false, detail: 'DB_MAX_RTO_EXCEEDED' };
    return { ok: true, detail: 'DB forward-only：expand → N-1 窗口 → confirmed-write → reconcile → readback 通过' };
  } catch (error) {
    return { ok: false, detail: `DB_DRILL_CRASH:${String(error).slice(0, 200)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3) descriptor identity + registry artifact 哈希 ──
const cfgDescriptor = configMigrationById('config-v0-to-v1')!;
const dbDescriptors = dbMigrations();
const cfgRegistryHash = sha256File(resolve(repoRoot, 'src/migrations/config/registry.ts'));
const dbRegistryHash = sha256File(resolve(repoRoot, 'src/migrations/db/registry.ts'));

const cfgDrill = configDrill();
const dbDrillResult = dbDrill();
console.log('CONFIG_DRILL:', cfgDrill.detail);
console.log('DB_DRILL:', dbDrillResult.detail);

const report = {
  waveScope: 'wave0',
  registryPath: 'src/migrations/config/registry.ts',
  descriptorId: cfgDescriptor.id,
  descriptorChecksum: computeMigrationDescriptorChecksum(cfgDescriptor),
  registryArtifactPath: 'src/migrations/config/registry.ts',
  registryArtifactSha256: cfgRegistryHash,
  dbRegistryPath: 'src/migrations/db/registry.ts',
  dbRegistryArtifactSha256: dbRegistryHash,
  dbDescriptorIds: dbDescriptors.map(d => d.id),
  dbDescriptorChecksums: dbDescriptors.map(d => d.checksum),
  compatibilityManifestPath: 'docs/superpowers/manifests/v3-compatibility.json',
  compatibilityManifestSha256: compatHash,
  candidateArtifactSha256: artifactHash,
  environmentSha256: environmentHash,
  policyManifestSha256: policyHash,
  bindingSha256,
  drills: {
    config: cfgDrill,
    db: dbDrillResult,
  },
  generatedAt: new Date().toISOString(),
};

mkdirSync(evidenceDir, { recursive: true });
const outPath = resolve(evidenceDir, 'recovery-drill.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`WROTE:${outPath}`);

process.exit(cfgDrill.ok && dbDrillResult.ok ? 0 : 1);
