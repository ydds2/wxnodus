// tests/branding-personalization.contract.test.ts — 「独立艺术品」包装层雏形：每用户命名/图标化配置
// （branding 进 config schema → 校验 → 原子持久化 → workspace 优先解析 → 非法输入绝不部分写入）
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService, DEFAULT_BRANDING } from '../src/application/config/configService.js';
import { BRANDING_LIMITS, validateBranding } from '../src/domain/config/configSchema.js';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxnodus-brand-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const service = () => new ConfigService(new ConfigRepository({
  userFile: join(root, 'config.json'),
  workspaceFile: join(root, '.wxnodus', 'config.yaml'),
}));

describe('per-user branding（独立艺术品雏形）', () => {
  it('persists name+icon, reads back, and resolves branding', async () => {
    const svc = service();
    await expect(svc.setBranding('user', { name: '我的工坊', icon: '🛠️' })).resolves.toMatchObject({
      ok: true, value: { branding: { name: '我的工坊', icon: '🛠️' } },
    });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).branding).toEqual({ name: '我的工坊', icon: '🛠️' });
    await expect(svc.resolveBranding()).resolves.toMatchObject({ ok: true, value: { name: '我的工坊', icon: '🛠️' } });
  });

  it('falls back to the default name without branding and lets workspace override user', async () => {
    const svc = service();
    await expect(svc.resolveBranding()).resolves.toMatchObject({ ok: true, value: DEFAULT_BRANDING });
    await svc.setBranding('user', { name: '用户版' });
    await svc.setBranding('workspace', { name: '项目版' });
    await expect(svc.resolveBranding()).resolves.toMatchObject({ ok: true, value: { name: '项目版', icon: null } });
  });

  it.each([
    ['name too long', { name: 'x'.repeat(BRANDING_LIMITS.nameMaxChars + 1) }],
    ['name empty', { name: '' }],
    ['control characters', { name: 'bad\u0000name' }],
    ['icon too long', { icon: 'x'.repeat(BRANDING_LIMITS.iconMaxChars + 1) }],
    ['non-object branding', 'branding-as-string'],
  ] as const)('rejects %s with CONFIG_SCHEMA_INVALID and never partially writes', async (_label, branding) => {
    const svc = service();
    await expect(svc.setBranding('user', branding)).resolves.toMatchObject({
      ok: false, error: { code: 'CONFIG_SCHEMA_INVALID' },
    });
    expect(validateBranding(branding)).toBe(null);
    // 已有配置不被破坏
    await svc.setBranding('user', { name: '合法名' });
    await svc.setBranding('user', branding);
    await expect(svc.resolveBranding()).resolves.toMatchObject({ ok: true, value: { name: '合法名' } });
  });

  it('accepts data-URI icons within limits and trims no content silently', async () => {
    const svc = service();
    const icon = `data:image/png;base64,${'A'.repeat(100)}`;
    await expect(svc.setBranding('user', { name: 'wxnodus-pro', icon })).resolves.toMatchObject({
      ok: true, value: { branding: { name: 'wxnodus-pro', icon } },
    });
  });
});
