// src/migrations/config/runner.ts — config 迁移执行器：备份→升级/降级→失败恢复原字节→run record
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backupFile, hashFile } from '../backup.js';
import { verifyMigrationDescriptorChecksum } from '../types.js';
import type { MigrationRunRecord, MigrationDescriptor, RollbackableMigrationDescriptor } from '../types.js';
import type { ConfigState, ConfigConfirmedWrite } from './registry.js';

export interface ConfigMigrationOutcome {
  status: 'applied' | 'failed';
  record: MigrationRunRecord;
}

function partitionFile(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

function recordsFile(dataDir: string): string {
  return join(dataDir, 'migration-runs.json');
}

function loadRecords(dataDir: string): MigrationRunRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(recordsFile(dataDir), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sleepMs(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function atomicWrite(filePath: string, text: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const tmp = `${filePath}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  // Windows bounded rename retry（防病毒扫描/索引瞬时锁）
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (error) {
      if (attempt >= 4) {
        try { rmSync(tmp, { force: true }); } catch { /* 尽力 */ }
        throw error;
      }
      sleepMs(25 * (attempt + 1));
    }
  }
}

function saveRecords(dataDir: string, records: MigrationRunRecord[]): void {
  atomicWrite(recordsFile(dataDir), JSON.stringify(records, null, 2));
}

/** 读取当前 config state（文件缺失 → v0 空对象） */
function readState(dataDir: string): ConfigState {
  const file = partitionFile(dataDir);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as ConfigState;
}

function startRecord(
  descriptor: MigrationDescriptor<ConfigState, ConfigConfirmedWrite>,
  dataDir: string,
  sourceHash: string,
  backupPath: string,
): MigrationRunRecord {
  const record: MigrationRunRecord = {
    id: descriptor.id,
    strategy: descriptor.strategy,
    status: 'started',
    sourceHash,
    backupPath,
    startedAt: new Date().toISOString(),
  };
  saveRecords(dataDir, [...loadRecords(dataDir), record]);
  return record;
}

function finishRecord(dataDir: string, record: MigrationRunRecord): void {
  const records = loadRecords(dataDir);
  const index = records.findIndex(r => r.id === record.id && r.startedAt === record.startedAt);
  if (index >= 0) records[index] = record;
  else records.push(record);
  saveRecords(dataDir, records);
}

/** 失败恢复原字节：迁移前不存在则删除；存在则逐字节还原 */
function restoreOriginalBytes(file: string, originalBytes: Buffer | null): void {
  if (originalBytes === null) {
    try { if (existsSync(file)) rmSync(file); } catch { /* 尽力 */ }
  } else {
    atomicWrite(file, originalBytes.toString('utf8'));
  }
}

type ConfigRollbackableDescriptor = RollbackableMigrationDescriptor<ConfigState, ConfigConfirmedWrite>;

function runStateChange(
  dataDir: string,
  descriptor: ConfigRollbackableDescriptor,
  change: (state: ConfigState) => void,
): ConfigMigrationOutcome {
  if (!verifyMigrationDescriptorChecksum(descriptor)) {
    throw new Error(`CONFIG_MIGRATION_CHECKSUM_MISMATCH:${descriptor.id}`);
  }
  const file = partitionFile(dataDir);
  const originalBytes = existsSync(file) ? readFileSync(file) : null;
  const backup = backupFile(file, dataDir);
  const record = startRecord(descriptor, dataDir, originalBytes ? hashFile(file) : '', backup?.path ?? '');

  try {
    const state = readState(dataDir);
    descriptor.validate(state);
    change(state);
    atomicWrite(file, JSON.stringify(state, null, 2));
    record.status = 'applied';
    record.targetHash = hashFile(file);
    record.finishedAt = new Date().toISOString();
    finishRecord(dataDir, record);
    return { status: 'applied', record };
  } catch (error) {
    restoreOriginalBytes(file, originalBytes);
    record.status = 'failed';
    record.errorCode = (error as { code?: string }).code ?? 'CONFIG_MIGRATION_FAILED';
    record.finishedAt = new Date().toISOString();
    finishRecord(dataDir, record);
    return { status: 'failed', record };
  }
}

/** 执行 rollbackable 升级：备份 → upgrade → 原子写；任何失败恢复原字节并记录 failed */
export function runConfigUpgrade(dataDir: string, descriptor: ConfigRollbackableDescriptor): ConfigMigrationOutcome {
  return runStateChange(dataDir, descriptor, state => descriptor.upgrade(state));
}

/** 执行 rollbackable 降级：备份 → 版本校验 → downgrade；失败同样恢复原字节 */
export function runConfigDowngrade(dataDir: string, descriptor: ConfigRollbackableDescriptor): ConfigMigrationOutcome {
  return runStateChange(dataDir, descriptor, state => {
    if (state.configVersion !== descriptor.toVersion) {
      throw new Error(`CONFIG_MIGRATION_VERSION_MISMATCH:${descriptor.id}`);
    }
    descriptor.downgrade(state);
  });
}

/** 读取 run records（新→旧） */
export function configMigrationRecords(dataDir: string): MigrationRunRecord[] {
  return loadRecords(dataDir).reverse();
}
