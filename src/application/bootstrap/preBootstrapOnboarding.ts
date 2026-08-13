// src/application/bootstrap/preBootstrapOnboarding.ts — 严格 pre-bootstrap 参数解析 + 首次 zh/en 语言选择
import type { OperationResult } from '../../protocol/results.js';
import { ConfigRepository } from '../../infrastructure/config/configRepository.js';
import { configError, inferSystemLocale, normalizeLocale, validateConfigDocument, type ConfigSource, type Locale } from '../../domain/config/configSchema.js';
import { resolveLocalePrecedence } from '../../domain/config/configPrecedence.js';
import { translate } from '../i18n/i18nService.js';

export interface PreBootstrapArgs {
  help: boolean;
  version: boolean;
  nonInteractive: boolean;
  lang?: Locale;
  dataDir?: string;
}

export interface PreBootstrapDecision {
  mode: 'continue' | 'print-and-exit' | 'onboarding-required' | 'error';
  locale?: Locale;
  source?: ConfigSource;
  output?: string;
  exitCode?: 0 | 2;
  args?: PreBootstrapArgs;
}

const VALUE_FLAGS = new Set(['--lang', '--data-dir', '--prompt', '-p', '--cwd', '-C', '--session', '-s', '--port', '--output-schema']);
const BOOL_FLAGS = new Set(['--help', '-h', '--version', '-v', '--json', '--wire', '--serve', '--strict-mcp-config', '--ephemeral']);

export function parsePreBootstrapArgs(argv: string[]): OperationResult<PreBootstrapArgs> {
  const out: PreBootstrapArgs = { help: false, version: false, nonInteractive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const [flag, inline] = token.startsWith('--') && token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    if (BOOL_FLAGS.has(flag)) {
      if (flag === '--help' || flag === '-h') out.help = true;
      if (flag === '--version' || flag === '-v') out.version = true;
      if (['--json', '--wire', '--serve'].includes(flag)) out.nonInteractive = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[index + 1];
      if (!value || value.startsWith('-')) {
        return { ok: false, error: configError('CONFIG_MISSING_VALUE', 'config.argument.missing', { flag }) };
      }
      if (inline === undefined) index += 1;
      if (flag === '--lang') {
        const locale = normalizeLocale(value);
        if (!locale) return { ok: false, error: configError('CONFIG_INVALID_LOCALE', 'config.locale.invalid', { value }) };
        out.lang = locale;
      }
      if (flag === '--data-dir') out.dataDir = value;
      if (['--prompt', '-p'].includes(flag)) out.nonInteractive = true;
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, error: configError('CONFIG_UNKNOWN_FLAG', 'config.argument.unknown', { flag: token }) };
    }
  }
  return { ok: true, value: out };
}

export interface DecidePreBootstrapInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  systemLocale?: string;
  readWorkspaceLocale(): Promise<Locale | undefined>;
  readUserLocale(): Promise<Locale | undefined>;
  promptLanguage(): Promise<Locale>;
  persistUserLocale(locale: Locale): Promise<void>;
}

export async function decidePreBootstrap(input: DecidePreBootstrapInput): Promise<PreBootstrapDecision> {
  const parsed = parsePreBootstrapArgs(input.argv);
  if (!parsed.ok) return { mode: 'error', exitCode: 2, output: parsed.error.code };
  if (parsed.value.help) return { mode: 'print-and-exit', exitCode: 0, output: 'help', args: parsed.value };
  if (parsed.value.version) return { mode: 'print-and-exit', exitCode: 0, output: 'version', args: parsed.value };

  const [workspace, user] = await Promise.all([input.readWorkspaceLocale(), input.readUserLocale()]);
  const explicit = resolveLocalePrecedence({
    cli: parsed.value.lang,
    env: input.env.WXNODUS_LANG,
    workspace,
    user,
    systemLocale: input.systemLocale,
  });
  if (parsed.value.lang || normalizeLocale(input.env.WXNODUS_LANG) || workspace || user) {
    // 注意：显式给出 locale 字段（ResolvedConfig 的 value/source 是内部形状——此前展开导致已持久化/--lang 路径丢失 locale，CLI 回退 'en'）
    return { mode: 'continue', locale: explicit.value, source: explicit.source, args: parsed.value };
  }
  if (!input.isTTY || parsed.value.nonInteractive) {
    return {
      mode: 'continue',
      locale: inferSystemLocale(input.systemLocale),
      source: 'default',
      args: parsed.value,
    };
  }
  const locale = await input.promptLanguage();
  await input.persistUserLocale(locale);
  return { mode: 'onboarding-required', locale, source: 'user', args: parsed.value };
}

// ── CLI 集成 helper（W2-01 Step 6）：文件只读 / stdio 语言选择 / 原子持久化 ──
/** 只读 locale 文件；不存在/损坏均返回 undefined（onboarding fail-soft，不阻断启动） */
export async function readLocaleFile(file: string): Promise<Locale | undefined> {
  try {
    const repo = new ConfigRepository({ userFile: file, workspaceFile: file });
    const result = await repo.read('user');
    return result.ok ? result.value.locale : undefined;
  } catch { return undefined; }
}

/** stdio 首次语言选择：1=中文（默认），2=English */
export function promptLanguageOnStdio(): Promise<Locale> {
  return new Promise(resolve => {
    process.stdout.write(`${translate('en', 'onboarding.selectLanguage')}\n> `);
    const onData = (chunk: Buffer) => {
      const input = chunk.toString('utf8').trim();
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(input === '2' ? 'en' : 'zh-CN');
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

/** 首次选择持久化到 user config（原子写；已有配置 merge 保留 extensions/profile） */
export async function persistPreBootstrapLocale(file: string, locale: Locale): Promise<void> {
  const repo = new ConfigRepository({ userFile: file, workspaceFile: file });
  const current = await repo.read('user');
  const base = current.ok ? current.value : undefined;
  const merged = validateConfigDocument({
    configVersion: 1,
    onboardingVersion: 1,
    installationProfile: 'standard',
    extensions: {},
    ...(base ?? {}),
    locale,
  });
  if (merged.ok) await repo.write('user', merged.value);
}
