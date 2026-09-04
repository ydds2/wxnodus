// src/migrations/backup.ts — 字节级备份（原始字节 + 完整 SHA-256，验证/恢复合同）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface FileBackup {
  path: string;
  sha256: string;
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 备份文件原始字节到 dataDir/migration-backups/<basename>.<ts>.bak；文件不存在返回 null */
export function backupFile(filePath: string, dataDir: string): FileBackup | null {
  if (!existsSync(filePath)) return null;
  const bytes = readFileSync(filePath);
  const backupsDir = join(dataDir, 'migration-backups');
  mkdirSync(backupsDir, { recursive: true });
  const base = filePath.replace(/[\\/]/g, '_').replace(/^[a-zA-Z]:/, '');
  const backupPath = join(backupsDir, `${base}.${Date.now()}.bak`);
  copyFileSync(filePath, backupPath);
  return { path: backupPath, sha256: sha256Of(bytes) };
}

/** 重算备份文件 SHA-256 并与记录比对 */
export function verifyBackup(backup: FileBackup): boolean {
  if (!existsSync(backup.path)) return false;
  return sha256Of(readFileSync(backup.path)) === backup.sha256;
}

/** 用备份恢复目标文件（原子写）；调用方需自行确认 verifyBackup 通过 */
export function restoreBackup(filePath: string, backup: FileBackup): void {
  const bytes = readFileSync(backup.path);
  const tmp = `${filePath}.restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, filePath);
}

/** 计算文件当前字节的完整 SHA-256（文件不存在返回空串） */
export function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return '';
  return sha256Of(readFileSync(filePath));
}
