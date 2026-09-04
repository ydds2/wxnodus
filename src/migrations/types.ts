// src/migrations/types.ts — 迁移 descriptor 判别联合与演练合同
import { createHash } from 'node:crypto';

export interface MigrationBase<TState> {
  id: string;
  fromVersion: number;
  toVersion: number;
  checksum: string;
  /** 行为版本标识：升级/降级逻辑变化时必须递增，descriptor checksum 随之为新值 */
  behaviorVersion: string;
  validate(state: TState): void;
}

export interface RollbackableMigrationDescriptor<TState, TConfirmedWrite>
  extends MigrationBase<TState> {
  strategy: 'rollbackable';
  upgrade(state: TState): void;
  downgrade(state: TState): void;
  verifyConfirmedWrites(before: TConfirmedWrite[], after: TConfirmedWrite[]): void;
  maxRtoMs: number;
}

export interface ForwardOnlyMigrationDescriptor<TState, TConfirmedWrite, TReconcile, TRecovery>
  extends MigrationBase<TState> {
  strategy: 'forward-only';
  expand(state: TState): void;
  contract(state: TState): void;
  /** 占位 brand：保持 MigrationDescriptor 判别联合的位置参数稳定 */
  readonly _confirmedWriteBrand?: TConfirmedWrite;
  nMinusOneWindow: {
    minReaderVersion: string;
    minWriterVersion: string;
    closeCondition: string;
  };
  reconcile(state: TState): TReconcile;
  recovery(state: TState, cause: Error): TRecovery;
  maxRtoMs: number;
}

export type MigrationDescriptor<TState, TConfirmedWrite = unknown, TReconcile = unknown, TRecovery = unknown> =
  | RollbackableMigrationDescriptor<TState, TConfirmedWrite>
  | ForwardOnlyMigrationDescriptor<TState, TConfirmedWrite, TReconcile, TRecovery>;

export type WaveMigrationDrillContract =
  | {
      strategy: 'rollbackable';
      steps: readonly ['backup', 'upgrade', 'confirmed-write', 'downgrade', 'verify-confirmed-writes', 're-upgrade'];
    }
  | {
      strategy: 'forward-only';
      steps: readonly ['backup', 'expand', 'n-minus-one-read-write-window', 'confirmed-write', 'reconcile', 'contract', 'recovery', 'verify-confirmed-writes'];
    };

export interface MigrationRunRecord {
  id: string;
  strategy: MigrationDescriptor<unknown>['strategy'];
  status: 'started' | 'applied' | 'failed' | 'recovered';
  sourceHash: string;
  targetHash?: string;
  backupPath: string;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
}

export interface MigrationDescriptorIdentity {
  id: string;
  strategy: 'rollbackable' | 'forward-only';
  fromVersion: number;
  toVersion: number;
  checksum: string;
  maxRtoMs: number;
}

export function migrationDescriptorIdentity(
  descriptor: MigrationDescriptor<unknown>,
): MigrationDescriptorIdentity {
  return {
    id: descriptor.id,
    strategy: descriptor.strategy,
    fromVersion: descriptor.fromVersion,
    toVersion: descriptor.toVersion,
    checksum: descriptor.checksum,
    maxRtoMs: descriptor.maxRtoMs,
  };
}

/** descriptor checksum 覆盖范围（排除 checksum 字段本身 + 行为版本标识） */
export function migrationChecksumInput(
  descriptor: MigrationDescriptor<unknown>,
): Record<string, unknown> {
  const { checksum: _checksum, ...identity } = migrationDescriptorIdentity(descriptor);
  void _checksum;
  return { ...identity, behaviorVersion: descriptor.behaviorVersion };
}

export function computeMigrationDescriptorChecksum(descriptor: MigrationDescriptor<unknown>): string {
  const canonical = JSON.stringify(
    Object.entries(migrationChecksumInput(descriptor)).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function verifyMigrationDescriptorChecksum(
  descriptor: MigrationDescriptor<unknown>,
): boolean {
  return computeMigrationDescriptorChecksum(descriptor) === descriptor.checksum;
}
