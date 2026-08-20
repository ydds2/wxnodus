import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';
import { PersonalizationService } from '../src/application/personalization/personalizationService.js';
import { createPersonalizationRpcHandlers } from '../src/protocol/personalization.js';

let root: string;
let repository: ConfigRepository;
let service: PersonalizationService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wxn-w2-personalization-'));
  repository = new ConfigRepository({
    userFile: join(root, 'user', 'config.json'),
    workspaceFile: join(root, 'workspace', '.wxnodus', 'config.yaml'),
  });
  await repository.write('user', {
    configVersion: 1,
    onboardingVersion: 1,
    locale: 'en',
    installationProfile: 'standard',
    extensions: {},
  });
  service = new PersonalizationService(repository);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('W2-02 PersonalizationService', () => {
  it('persists a personality update and reads the same snapshot after service restart', async () => {
    const updated = await service.update('user', {
      displayName: 'Ada',
      persona: 'precise',
      memory: { enabled: true, retention: 'persistent' },
    });
    expect(updated.ok).toBe(true);
    const restarted = new PersonalizationService(repository);
    const readBack = await restarted.get('user');
    expect(readBack).toEqual(updated);
  });

  it('keeps workspace override separate and falls back to user after clear', async () => {
    await service.update('user', { persona: 'user-persona', theme: 'dark' });
    await service.update('workspace', { persona: 'workspace-persona' });
    const merged = await service.resolve();
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(merged.value.profile).toMatchObject({
      persona: 'workspace-persona', theme: 'dark',
    });
    await service.clear('workspace');
    const fallback = await service.resolve();
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(fallback.value.profile).toMatchObject({
      persona: 'user-persona', theme: 'dark',
    });
  });

  it('exports/imports exactly and rejects invalid input without partial write', async () => {
    await service.update('user', { theme: 'light', toolPolicy: { approvalMode: 'always' } });
    const portable = await service.export('user');
    expect(portable.ok).toBe(true);
    const before = await service.get('user');
    const invalid = await service.import('user', {
      schemaVersion: 1,
      profile: { locale: 'fr', voice: { enabled: true } },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('PERSONALIZATION_IMPORT_INVALID');
    expect(await service.get('user')).toEqual(before);
    if (portable.ok) expect((await service.import('workspace', portable.value)).ok).toBe(true);
  });

  it('returns redacted full config and setup/personality use the real service', async () => {
    const handlers = createPersonalizationRpcHandlers({
      service,
      readFullConfig: async () => ({
        apiKey: 'secret-value',
        apiKeyRef: 'secret://providers/openai/apiKey',
        nested: { token: 'secret-token', safe: true },
      }),
    });
    const setup = await handlers['personalization.setup']({
      scope: 'user',
      patch: { displayName: 'Lin', locale: 'zh-CN' },
    });
    expect(setup.ok).toBe(true);
    const afterSetup = await service.get('user');
    expect(afterSetup.ok).toBe(true);
    if (afterSetup.ok) expect(afterSetup.value.profile.displayName).toBe('Lin');
    const full = await handlers['config.getFull']({});
    expect(full).toEqual({
      ok: true,
      value: {
        apiKey: '[REDACTED]',
        apiKeyRef: 'secret://providers/openai/apiKey',
        nested: { token: '[REDACTED]', safe: true },
      },
    });
  });

  it('uses stable validation code instead of localized text', async () => {
    const result = await service.update('user', { modelPolicy: { allowRemote: 'yes' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERSONALIZATION_SCHEMA_INVALID');
  });
});
