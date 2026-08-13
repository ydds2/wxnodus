// src/domain/config/configSchema.ts — 配置文档 schema 与稳定错误码
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export type Locale = 'zh-CN' | 'en';
export type ConfigScope = 'user' | 'workspace';
export type ConfigSource = 'cli' | 'env' | 'workspace' | 'user' | 'default';
export type InstallationProfile = 'core' | 'standard' | 'full-local-ai';

/** 「独立艺术品」包装层雏形：每用户可命名/图标化（icon 为短文本/emoji/数据 URI，永不落第三方） */
export interface BrandingConfig { name?: string; icon?: string }

export interface ConfigDocument {
  configVersion: 1;
  onboardingVersion: 1;
  locale?: Locale;
  installationProfile: InstallationProfile;
  extensions: Record<string, unknown>;
  branding?: BrandingConfig;
}

export const BRANDING_LIMITS = { nameMaxChars: 40, iconMaxChars: 4096 } as const;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** undefined=未声明；null=非法（控制字符/超长/空串） */
export function validateBranding(value: unknown): BrandingConfig | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = raw.name === undefined ? undefined : String(raw.name);
  const icon = raw.icon === undefined ? undefined : String(raw.icon);
  const nameValid = name === undefined ||
    (name.length > 0 && name.length <= BRANDING_LIMITS.nameMaxChars && !CONTROL_CHARS.test(name));
  const iconValid = icon === undefined ||
    (icon.length > 0 && icon.length <= BRANDING_LIMITS.iconMaxChars && !CONTROL_CHARS.test(icon));
  if (!nameValid || !iconValid) return null;
  return { ...(name !== undefined ? { name } : {}), ...(icon !== undefined ? { icon } : {}) };
}

export const DEFAULT_CONFIG: ConfigDocument = {
  configVersion: 1,
  onboardingVersion: 1,
  installationProfile: 'standard',
  extensions: {},
};

export function configError(
  code: string,
  messageKey: string,
  details?: Record<string, unknown>,
): GatewayError {
  return { code, message: messageKey, messageKey, retryable: false, details };
}

export function normalizeLocale(value: unknown): Locale | undefined {
  if (value === 'zh' || value === 'zh-CN') return 'zh-CN';
  if (value === 'en') return 'en';
  return undefined;
}

export function inferSystemLocale(value: string | undefined): Locale {
  return value?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function validateConfigDocument(value: unknown): OperationResult<ConfigDocument> {
  if (value === undefined || value === null) return { ok: true, value: { ...DEFAULT_CONFIG } };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid') };
  }
  const raw = value as Record<string, unknown>;
  const locale = raw.locale === undefined ? undefined : normalizeLocale(raw.locale);
  const profile = raw.installationProfile ?? 'standard';
  const branding = validateBranding(raw.branding);
  if (raw.configVersion !== 1 || raw.onboardingVersion !== 1 ||
      (raw.locale !== undefined && locale === undefined) ||
      (branding === null) ||
      !['core', 'standard', 'full-local-ai'].includes(String(profile)) ||
      (raw.extensions !== undefined &&
        (typeof raw.extensions !== 'object' || raw.extensions === null || Array.isArray(raw.extensions)))) {
    return { ok: false, error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid') };
  }
  return {
    ok: true,
    value: {
      configVersion: 1,
      onboardingVersion: 1,
      locale,
      installationProfile: profile as InstallationProfile,
      extensions: (raw.extensions ?? {}) as Record<string, unknown>,
      ...(branding !== undefined ? { branding } : {}),
    },
  };
}
