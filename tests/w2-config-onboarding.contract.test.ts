import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';
import { ConfigService } from '../src/application/config/configService.js';
import {
  decidePreBootstrap,
  parsePreBootstrapArgs,
} from '../src/application/bootstrap/preBootstrapOnboarding.js';
import { messageKeys, translate } from '../src/application/i18n/i18nService.js';

let root: string;
let userFile: string;
let workspaceFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wxn-w2-config-'));
  userFile = join(root, 'user', 'config.json');
  workspaceFile = join(root, 'workspace', '.wxnodus', 'config.yaml');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('W2-01 config precedence and pre-bootstrap onboarding', () => {
  it('resolves CLI > env > workspace > user > default and preserves source', async () => {
    const repo = new ConfigRepository({ userFile, workspaceFile });
    await repo.write('user', {
      configVersion: 1,
      onboardingVersion: 1,
      locale: 'zh-CN',
      installationProfile: 'standard',
      extensions: {},
    });
    await repo.write('workspace', {
      configVersion: 1,
      onboardingVersion: 1,
      locale: 'en',
      installationProfile: 'standard',
      extensions: { future: { keep: true } },
    });
    const service = new ConfigService(repo);
    const resolved = async (ctx: { cli?: unknown; env?: unknown; systemLocale?: string }) => {
      const r = await service.resolveLocale(ctx);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error.code);
      return r.value;
    };

    expect(await resolved({ cli: 'zh-CN', env: 'en' })).toEqual({
      value: 'zh-CN', source: 'cli',
    });
    expect(await resolved({ env: 'zh-CN' })).toEqual({
      value: 'zh-CN', source: 'env',
    });
    expect(await resolved({})).toEqual({ value: 'en', source: 'workspace' });

    await repo.remove('workspace');
    expect(await resolved({})).toEqual({ value: 'zh-CN', source: 'user' });
    await repo.remove('user');
    expect(await resolved({ systemLocale: 'fr-FR' })).toEqual({
      value: 'en', source: 'default',
    });
  });

  it('rejects unknown flags, missing values and invalid locale with stable exit-2 codes', () => {
    const unknown = parsePreBootstrapArgs(['--wat']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('CONFIG_UNKNOWN_FLAG');

    const missing = parsePreBootstrapArgs(['--lang']);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('CONFIG_MISSING_VALUE');

    const invalid = parsePreBootstrapArgs(['--lang', 'fr']);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('CONFIG_INVALID_LOCALE');
  });

  it('help/version/non-TTY never prompt or write, while clean TTY persists before bootstrap', async () => {
    const promptLanguage = vi.fn(async () => 'zh-CN' as const);
    const persistUserLocale = vi.fn(async () => undefined);
    const readUserLocale = vi.fn(async () => undefined);
    const readWorkspaceLocale = vi.fn(async () => undefined);

    const help = await decidePreBootstrap({
      argv: ['--help'], env: {}, isTTY: true, systemLocale: 'en-US',
      promptLanguage, persistUserLocale, readUserLocale, readWorkspaceLocale,
    });
    expect(help).toMatchObject({ mode: 'print-and-exit', exitCode: 0 });
    expect(promptLanguage).not.toHaveBeenCalled();
    expect(persistUserLocale).not.toHaveBeenCalled();

    const nonTty = await decidePreBootstrap({
      argv: ['--json'], env: {}, isTTY: false, systemLocale: 'zh-CN',
      promptLanguage, persistUserLocale, readUserLocale, readWorkspaceLocale,
    });
    expect(nonTty).toMatchObject({ mode: 'continue', locale: 'zh-CN', source: 'default' });
    expect(promptLanguage).not.toHaveBeenCalled();
    expect(persistUserLocale).not.toHaveBeenCalled();

    const tty = await decidePreBootstrap({
      argv: [], env: {}, isTTY: true, systemLocale: 'en-US',
      promptLanguage, persistUserLocale, readUserLocale, readWorkspaceLocale,
    });
    expect(tty).toMatchObject({ mode: 'onboarding-required', locale: 'zh-CN', source: 'user' });
    expect(promptLanguage).toHaveBeenCalledTimes(1);
    expect(persistUserLocale).toHaveBeenCalledWith('zh-CN');
  });

  it('atomically round-trips YAML extension bag and leaves no temp file', async () => {
    const repo = new ConfigRepository({ userFile, workspaceFile });
    const written = await repo.write('workspace', {
      configVersion: 1,
      onboardingVersion: 1,
      locale: 'en',
      installationProfile: 'standard',
      extensions: { future: { list: ['a', 'b'], nested: { enabled: true } } },
    });
    expect(written.ok).toBe(true);
    expect(existsSync(`${workspaceFile}.tmp`)).toBe(false);
    expect(readFileSync(workspaceFile, 'utf8')).toContain('future:');
    const readBack = await repo.read('workspace');
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.value.extensions).toEqual({
      future: { list: ['a', 'b'], nested: { enabled: true } },
    });
  });

  it('keeps zh/en message keys identical and English behavioral prompt free of CJK', () => {
    expect(messageKeys('zh-CN')).toEqual(messageKeys('en'));
    expect(translate('en', 'system.behavior')).toBe('Follow structured policy and capability decisions.');
    expect(translate('en', 'system.behavior')).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('does not create the user file merely by reading clean config', async () => {
    writeFileSync(join(root, 'sentinel.txt'), 'unchanged', 'utf8');
    const repo = new ConfigRepository({ userFile, workspaceFile });
    expect((await repo.read('user')).ok).toBe(true);
    expect(existsSync(userFile)).toBe(false);
  });
});
