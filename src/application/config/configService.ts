// src/application/config/configService.ts — 配置应用服务：precedence 解析 + 原子写（单一事实源）
import type { OperationResult } from '../../protocol/results.js';
import type { ConfigDocument, ConfigScope, Locale } from '../../domain/config/configSchema.js';
import { normalizeLocale, validateConfigDocument } from '../../domain/config/configSchema.js';
import { resolveLocalePrecedence, type ResolvedConfig } from '../../domain/config/configPrecedence.js';
import type { ConfigRepository } from '../../infrastructure/config/configRepository.js';

export interface ResolveLocaleContext { cli?: unknown; env?: unknown; systemLocale?: string }

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
}
