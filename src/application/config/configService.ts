// src/application/config/configService.ts — 配置应用服务：precedence 解析 + 原子写（单一事实源）
import type { OperationResult } from '../../protocol/results.js';
import type { BrandingConfig, ConfigDocument, ConfigScope, Locale } from '../../domain/config/configSchema.js';
import { configError, normalizeLocale, validateBranding, validateConfigDocument } from '../../domain/config/configSchema.js';
import { resolveLocalePrecedence, type ResolvedConfig } from '../../domain/config/configPrecedence.js';
import type { ConfigRepository } from '../../infrastructure/config/configRepository.js';

export interface ResolveLocaleContext { cli?: unknown; env?: unknown; systemLocale?: string }

/** 「独立艺术品」包装层：品牌解析（未配置回退默认名） */
export interface ResolvedBranding { name: string; icon: string | null }

export const DEFAULT_BRANDING: ResolvedBranding = { name: 'wxnodus', icon: null };

export class ConfigService {
  constructor(private readonly repository: ConfigRepository) {}

  async resolveLocale(context: ResolveLocaleContext): Promise<OperationResult<ResolvedConfig<Locale>>> {
    const [workspace, user] = await Promise.all([
      this.repository.read('workspace'), this.repository.read('user'),
    ]);
    if (!workspace.ok) return workspace;
    if (!user.ok) return user;
    return {
      ok: true,
      value: resolveLocalePrecedence({
        cli: context.cli,
        env: context.env,
        workspace: workspace.value.locale,
        user: user.value.locale,
        systemLocale: context.systemLocale,
      }),
    };
  }

  async set(scope: ConfigScope, patch: Partial<ConfigDocument>): Promise<OperationResult<ConfigDocument>> {
    const current = await this.repository.read(scope);
    if (!current.ok) return current;
    const merged = validateConfigDocument({ ...current.value, ...patch });
    if (!merged.ok) return merged;
    return this.repository.write(scope, merged.value);
  }

  async setLocale(scope: ConfigScope, locale: unknown): Promise<OperationResult<ConfigDocument>> {
    const normalized = normalizeLocale(locale);
    if (!normalized) return validateConfigDocument({ locale });
    return this.set(scope, { locale: normalized });
  }

  /** 每用户品牌化（命名/图标）——非法输入走 CONFIG_SCHEMA_INVALID，绝不部分写入 */
  async setBranding(scope: ConfigScope, branding: unknown): Promise<OperationResult<ConfigDocument>> {
    const checked = validateBranding(branding);
    if (checked === null) {
      return { ok: false, error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid', { field: 'branding' }) };
    }
    return this.set(scope, checked === undefined ? {} : { branding: checked });
  }

  async resolveBranding(): Promise<OperationResult<ResolvedBranding>> {
    const [workspace, user] = await Promise.all([
      this.repository.read('workspace'), this.repository.read('user'),
    ]);
    if (!workspace.ok) return workspace;
    if (!user.ok) return user;
    // workspace 优先（项目级覆盖用户级——与 locale precedence 同构）
    const branding: BrandingConfig | undefined = workspace.value.branding ?? user.value.branding;
    if (!branding?.name) return { ok: true, value: { ...DEFAULT_BRANDING, ...(branding?.icon ? { icon: branding.icon } : {}) } };
    return { ok: true, value: { name: branding.name, icon: branding.icon ?? null } };
  }
}
