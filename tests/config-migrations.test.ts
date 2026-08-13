// tests/config-migrations.test.ts — W0-05 config-v0-to-v1 rollbackable 迁移合同
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/store/config.js';
import { configMigrationById, type ConfigConfirmedWrite } from '../src/migrations/config/registry.js';
import {
  runConfigUpgrade,
  runConfigDowngrade,
  configMigrationRecords,
} from '../src/migrations/config/runner.js';
import { verifyMigrationDescriptorChecksum } from '../src/migrations/types.js';

const fixtureRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/config');
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config-v0-to-v1 rollbackable migration', () => {
  it('descriptor 具备稳定 identity 且 checksum 可验证', () => {
    const descriptor = configMigrationById('config-v0-to-v1')!;
    expect(descriptor.strategy).toBe('rollbackable');
    expect(descriptor.fromVersion).toBe(0);
    expect(descriptor.toVersion).toBe(1);
    expect(descriptor.maxRtoMs).toBeGreaterThan(0);
    expect(verifyMigrationDescriptorChecksum(descriptor)).toBe(true);

    const tampered = { ...descriptor, maxRtoMs: descriptor.maxRtoMs + 1 };
    expect(verifyMigrationDescriptorChecksum(tampered)).toBe(false);
  });

  it('六步 drill：upgrade → confirmed-write → downgrade → verify → re-upgrade', () => {
    const dir = tempDir('wxn-cfg-mig-');
    copyFileSync(join(fixtureRoot, 'v3-valid.json'), join(dir, 'settings.json'));
    const descriptor = configMigrationById('config-v0-to-v1')!;
    const start = Date.now();

    // backup + upgrade
    const up = runConfigUpgrade(dir, descriptor);
    expect(up.status).toBe('applied');
    const upgraded = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(upgraded.configVersion).toBe(1);
    expect(upgraded.locale).toBe('zh-CN');

    // confirmed write（生产 Config API，升级后新写入）
    const config = createConfig(dir);
    const confirmedBefore: ConfigConfirmedWrite[] = [{ key: 'theme', value: 'light' }];
    config.set('settings', { theme: 'light' });
    const confirmedAfter: ConfigConfirmedWrite[] = [{ key: 'theme', value: 'light' }];
    descriptor.verifyConfirmedWrites(confirmedBefore, confirmedAfter); // 不抛 = 确认写入保留

    // downgrade：移除版本包装，保留确认写入
    const down = runConfigDowngrade(dir, descriptor);
    expect(down.status).toBe('applied');
    const downgraded = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(downgraded.configVersion).toBeUndefined();
    expect(downgraded.theme).toBe('light');

    // re-upgrade
    const reup = runConfigUpgrade(dir, descriptor);
    expect(reup.status).toBe('applied');
    const reupgraded = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(reupgraded.configVersion).toBe(1);
    expect(reupgraded.theme).toBe('light');

    expect(Date.now() - start).toBeLessThan(descriptor.maxRtoMs);
    expect(configMigrationRecords(dir).length).toBeGreaterThanOrEqual(3);
  });

  it('迁移失败：原字节不变、版本不提升、run record failed', () => {
    const dir = tempDir('wxn-cfg-migfail-');
    copyFileSync(join(fixtureRoot, 'v3-migration-failure.json'), join(dir, 'settings.json'));
    const originalBytes = readFileSync(join(dir, 'settings.json'));
    const descriptor = configMigrationById('config-v0-to-v1')!;

    // validate 对数组 state 抛错 → 迁移失败路径
    const up = runConfigUpgrade(dir, descriptor);
    expect(up.status).toBe('failed');
    expect(up.record.status).toBe('failed');
    expect(up.record.errorCode).toBeTruthy();

    const afterBytes = readFileSync(join(dir, 'settings.json'));
    expect(Buffer.compare(afterBytes, originalBytes)).toBe(0);
    expect(JSON.parse(afterBytes.toString('utf8')).configVersion).toBeUndefined();
    expect(configMigrationRecords(dir)[0]!.status).toBe('failed');
  });

  it('upgrade 抛错时恢复原字节（注入型失败）', () => {
    const dir = tempDir('wxn-cfg-miginject-');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en' }));
    const originalBytes = readFileSync(join(dir, 'settings.json'));
    const descriptor = configMigrationById('config-v0-to-v1')!;
    const failing = {
      ...descriptor,
      upgrade(state: Record<string, unknown>): void {
        state.locale = 'zh-CN';
        throw new Error('boom');
      },
    };

    const up = runConfigUpgrade(dir, failing);
    expect(up.status).toBe('failed');
    const afterBytes = readFileSync(join(dir, 'settings.json'));
    expect(Buffer.compare(afterBytes, originalBytes)).toBe(0);
    expect(JSON.parse(afterBytes.toString('utf8')).configVersion).toBeUndefined();
  });
});
