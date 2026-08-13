// src/domain/config/configSchema.ts — 配置文档 schema 与稳定错误码
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export type Locale = 'zh-CN' | 'en';
export type ConfigScope = 'user' | 'workspace';
export type ConfigSource = 'cli' | 'env' | 'workspace' | 'user' | 'default';
export type InstallationProfile = 'core' | 'standard' | 'full-local-ai';

export interface ConfigDocument {
  configVersion: 1;
  onboardingVersion: 1;
  locale?: Locale;
  installationProfile: InstallationProfile;
  extensions: Record<string, unknown>;
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
  if (raw.configVersion !== 1 || raw.onboardingVersion !== 1 ||
      (raw.locale !== undefined && locale === undefined) ||
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
    },
  };
}
