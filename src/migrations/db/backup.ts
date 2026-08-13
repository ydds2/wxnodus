// src/migrations/db/backup.ts — SQLite 一致快照备份（VACUUM INTO）+ 完整性/SHA-256 验证 + 恢复
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export interface DbBackup {
  path: string;
  sha256: string;
}

/** VACUUM INTO 产生与打开连接一致的快照（WAL 场景不复制 data directory） */
export function createDbBackup(db: InstanceType<typeof Database>, dbPath: string, migrationId: string): DbBackup {
  const backupsDir = join(dirname(dbPath), 'db-migration-backups');
  mkdirSync(backupsDir, { recursive: true });
  const path = join(backupsDir, `${migrationId}.${Date.now()}.sqlite`);
  db.prepare(`VACUUM INTO '${path.replace(/'/g, "''")}'`).run();
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { path, sha256 };
}

/** 备份文件存在且原始字节 SHA-256 重算一致 */
export function verifyDbBackup(backup: DbBackup): { ok: true } | { ok: false; code: 'DB_BACKUP_CHECKSUM_MISMATCH' } {
  if (!existsSync(backup.path)) return { ok: false, code: 'DB_BACKUP_CHECKSUM_MISMATCH' };
  const actual = createHash('sha256').update(readFileSync(backup.path)).digest('hex');
  return actual === backup.sha256 ? { ok: true } : { ok: false, code: 'DB_BACKUP_CHECKSUM_MISMATCH' };
}

/** 打开备份并做 PRAGMA integrity_check + 可读性验证 */
export function verifyBackupIntegrity(backup: DbBackup): { ok: true } | { ok: false; code: 'DB_BACKUP_CHECKSUM_MISMATCH' | 'DB_BACKUP_INTEGRITY_FAILED' } {
  const checksum = verifyDbBackup(backup);
  if (!checksum.ok) return checksum;
  let probe: InstanceType<typeof Database> | null = null;
  try {
    probe = new Database(backup.path, { readonly: true });
    const row = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (row?.integrity_check !== 'ok') return { ok: false, code: 'DB_BACKUP_INTEGRITY_FAILED' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'DB_BACKUP_INTEGRITY_FAILED' };
  } finally {
    try { probe?.close(); } catch { /* 尽力 */ }
  }
}

/** 恢复：验证通过才允许覆盖；目标文件先原子替换。调用方负责关闭目标 DB 连接 */
export function restoreDbFromBackup(dbPath: string, backup: DbBackup): { ok: true } | { ok: false; code: 'DB_BACKUP_CHECKSUM_MISMATCH' | 'DB_BACKUP_INTEGRITY_FAILED' } {
  const checksum = verifyDbBackup(backup);
  if (!checksum.ok) return checksum;
  const integrity = verifyBackupIntegrity(backup);
  if (!integrity.ok) return integrity;
  const tmp = `${dbPath}.recover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  copyFileSync(backup.path, tmp);
  if (existsSync(dbPath)) rmSync(dbPath);
  renameSync(tmp, dbPath);
  return { ok: true };
}
