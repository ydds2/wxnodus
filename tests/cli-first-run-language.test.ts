// tests/cli-first-run-language.test.ts — CLI 首次安装系统语言选择（zh-CN/en）端到端契约：
// 首次 TTY 进入必须提示选择并持久化；`--lang`/env/既有配置优先且不提示；二次启动不再提示；
// stdio 提示对 [1]/[2] 返回 zh-CN/en；非 TTY 回退系统语言（default 来源，绝不假装修改用户选择）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decidePreBootstrap,
  promptLanguageOnStdio,
} from '../src/application/bootstrap/preBootstrapOnboarding.js';
import { translate } from '../src/application/i18n/i18nService.js';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';
import { en } from '../src/application/i18n/catalogs/en.js';
import { zhCN } from '../src/application/i18n/catalogs/zh-CN.js';

let root: string;
const userConfig = () => join(root, 'config.json');
const workspaceConfig = () => join(root, '.wxnodus', 'config.yaml');

const input = (overrides: Partial<Parameters<typeof decidePreBootstrap>[0]> = {}) => ({
  argv: [] as string[],
  env: {} as NodeJS.ProcessEnv,
  isTTY: true,
  systemLocale: 'zh-CN',
  readWorkspaceLocale: async () => undefined,
  readUserLocale: async () => undefined,
  promptLanguage: vi.fn(async () => 'zh-CN' as const),
  persistUserLocale: vi.fn(async () => undefined),
  ...overrides,
});

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxnodus-lang-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('CLI first-run language selection', () => {
  it('prompts exactly once on first TTY entry and persists the choice to user config', async () => {
    const repo = new ConfigRepository({ userFile: userConfig(), workspaceFile: workspaceConfig() });
    const decision = await decidePreBootstrap(input({
      readUserLocale: () => repo.read('user').then(result => result.ok ? result.value.locale : undefined),
      persistUserLocale: async locale => { await repo.write('user', { configVersion: 1, onboardingVersion: 1, installationProfile: 'standard', extensions: {}, locale }); },
    }));
    expect(decision.mode).toBe('onboarding-required');
    expect(decision.locale).toBe('zh-CN');
    expect(decision.source).toBe('user');
    expect(existsSync(userConfig())).toBe(true);
    const persisted = JSON.parse(readFileSync(userConfig(), 'utf8'));
    expect(persisted.locale).toBe('zh-CN');
  });

  it('does not prompt again on subsequent runs once locale is persisted', async () => {
    const repo = new ConfigRepository({ userFile: userConfig(), workspaceFile: workspaceConfig() });
    await repo.write('user', { configVersion: 1, onboardingVersion: 1, installationProfile: 'standard', extensions: {}, locale: 'en' });
    const prompt = vi.fn(async () => 'zh-CN' as const);
    const decision = await decidePreBootstrap(input({
      readUserLocale: () => repo.read('user').then(result => result.ok ? result.value.locale : undefined),
      promptLanguage: prompt,
    }));
    expect(decision.mode).toBe('continue');
    expect(decision.locale).toBe('en');
    expect(decision.source).toBe('user');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('lets --lang and WXNODUS_LANG bypass the prompt with cli/env precedence', async () => {
    const prompt = vi.fn(async () => 'zh-CN' as const);
    expect(await decidePreBootstrap(input({ argv: ['--lang', 'en'], promptLanguage: prompt }))).toMatchObject({
      mode: 'continue', locale: 'en', source: 'cli',
    });
    expect(await decidePreBootstrap(input({ env: { WXNODUS_LANG: 'zh-CN' }, promptLanguage: prompt }))).toMatchObject({
      mode: 'continue', locale: 'zh-CN', source: 'env',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rejects invalid --lang with exit code 2 instead of prompting', async () => {
    const prompt = vi.fn(async () => 'zh-CN' as const);
    expect(await decidePreBootstrap(input({ argv: ['--lang', 'fr'], promptLanguage: prompt }))).toMatchObject({
      mode: 'error', exitCode: 2, output: 'CONFIG_INVALID_LOCALE',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('falls back to the inferred system locale without prompting on non-TTY', async () => {
    const prompt = vi.fn(async () => 'zh-CN' as const);
    expect(await decidePreBootstrap(input({ isTTY: false, systemLocale: 'en-US', promptLanguage: prompt }))).toMatchObject({
      mode: 'continue', locale: 'en', source: 'default',
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('maps stdio prompt answers [1]/[2] to zh-CN/en and prints the bilingual question', async () => {
    const written: string[] = [];
    const handlers: Array<(chunk: Buffer) => void> = [];
    const stdin = {
      resume: vi.fn(),
      pause: vi.fn(),
      once: vi.fn((_event: string, handler: (chunk: Buffer) => void) => { handlers.push(handler); }),
    };
    const origOut = process.stdout.write;
    const origInOnce = process.stdin.once;
    const origInResume = process.stdin.resume;
    const origInPause = process.stdin.pause;
    Object.defineProperty(process.stdout, 'write', { value: (text: string) => { written.push(text); return true; }, configurable: true });
    Object.defineProperty(process.stdin, 'once', { value: stdin.once, configurable: true });
    Object.defineProperty(process.stdin, 'resume', { value: stdin.resume, configurable: true });
    Object.defineProperty(process.stdin, 'pause', { value: stdin.pause, configurable: true });
    try {
      const pendingZh = promptLanguageOnStdio();
      handlers.splice(0)[0]?.(Buffer.from('1\n'));
      expect(await pendingZh).toBe('zh-CN');
      const pendingEn = promptLanguageOnStdio();
      handlers.splice(0)[0]?.(Buffer.from('2\n'));
      expect(await pendingEn).toBe('en');
      expect(written.join('')).toContain('Select language');
      expect(written.join('')).toContain('中文');
    } finally {
      Object.defineProperty(process.stdout, 'write', { value: origOut, configurable: true });
      Object.defineProperty(process.stdin, 'once', { value: origInOnce, configurable: true });
      Object.defineProperty(process.stdin, 'resume', { value: origInResume, configurable: true });
      Object.defineProperty(process.stdin, 'pause', { value: origInPause, configurable: true });
    }
  });

  it('keeps the en and zh-CN catalogs key-identical and greets in the selected language', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(translate('zh-CN', 'onboarding.welcome')).toContain('中文');
    expect(translate('en', 'onboarding.welcome')).toContain('English');
  });
});
