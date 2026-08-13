// src/migrations/config/registry.ts — config 迁移注册表（config-v0-to-v1，rollbackable）
import { computeMigrationDescriptorChecksum } from '../types.js';
import type { MigrationDescriptor, RollbackableMigrationDescriptor } from '../types.js';

export type ConfigState = Record<string, unknown>;

export interface ConfigConfirmedWrite {
  key: string;
  value: unknown;
}

type ConfigMigration = MigrationDescriptor<ConfigState, ConfigConfirmedWrite>;

function baseDescriptor(): Omit<RollbackableMigrationDescriptor<ConfigState, ConfigConfirmedWrite>, 'checksum'> {
  return {
    id: 'config-v0-to-v1',
    fromVersion: 0,
    toVersion: 1,
    strategy: 'rollbackable' as const,
    behaviorVersion: '1',
    maxRtoMs: 60_000,
    validate(state: ConfigState): void {
      if (typeof state !== 'object' || state === null || Array.isArray(state)) {
        throw new Error(`CONFIG_MIGRATION_INVALID_STATE:${this.id}`);
      }
    },
    upgrade(state: ConfigState): void {
      state.configVersion = 1;
    },
    downgrade(state: ConfigState): void {
      delete state.configVersion;
    },
    verifyConfirmedWrites(before: ConfigConfirmedWrite[], after: ConfigConfirmedWrite[]): void {
      for (const entry of before) {
        const found = after.find(afterEntry => afterEntry.key === entry.key);
        if (!found || JSON.stringify(found.value) !== JSON.stringify(entry.value)) {
          throw new Error(`CONFIG_CONFIRMED_WRITE_LOST:${entry.key}`);
        }
      }
    },
  };
}

export function configMigrations(): ConfigMigration[] {
  const base = baseDescriptor();
  const descriptor: RollbackableMigrationDescriptor<ConfigState, ConfigConfirmedWrite> = {
    ...base,
    checksum: computeMigrationDescriptorChecksum(base as unknown as MigrationDescriptor<unknown>),
  };
  return [descriptor];
}

export function configMigrationById(id: string): RollbackableMigrationDescriptor<ConfigState, ConfigConfirmedWrite> | undefined {
  return configMigrations().find(descriptor => descriptor.id === id && descriptor.strategy === 'rollbackable') as
    | RollbackableMigrationDescriptor<ConfigState, ConfigConfirmedWrite>
    | undefined;
}
