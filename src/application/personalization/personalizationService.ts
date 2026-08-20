// src/application/personalization/personalizationService.ts — 个性化服务：scoped 读写 + resolve 合并 + import 无部分写入
import type { ConfigScope } from '../../domain/config/configSchema.js';
import type { OperationResult } from '../../protocol/results.js';
import {
  snapshot,
  validateProfile,
  type PersonalizationSnapshot,
  type PortablePersonalization,
} from '../../domain/personalization/personalization.js';
import type { ConfigRepository } from '../../infrastructure/config/configRepository.js';

const KEY = 'personalization';

export class PersonalizationService {
  constructor(private readonly repository: ConfigRepository) {}

  async get(scope: ConfigScope): Promise<OperationResult<PersonalizationSnapshot>> {
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const checked = validateProfile(config.value.extensions[KEY] ?? {});
    if (!checked.ok) return checked;
    return { ok: true, value: snapshot(scope, checked.value) };
  }

  async resolve(): Promise<OperationResult<PersonalizationSnapshot>> {
    const [user, workspace] = await Promise.all([this.get('user'), this.get('workspace')]);
    if (!user.ok) return user;
    if (!workspace.ok) return workspace;
    return { ok: true, value: snapshot('workspace', { ...user.value.profile, ...workspace.value.profile }) };
  }

  async update(scope: ConfigScope, patch: unknown): Promise<OperationResult<PersonalizationSnapshot>> {
    const checkedPatch = validateProfile(patch);
    if (!checkedPatch.ok) return checkedPatch;
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const current = validateProfile(config.value.extensions[KEY] ?? {});
    if (!current.ok) return current;
    const checkedMerged = validateProfile({ ...current.value, ...checkedPatch.value });
    if (!checkedMerged.ok) return checkedMerged;
    const written = await this.repository.write(scope, {
      ...config.value,
      locale: checkedMerged.value.locale ?? config.value.locale,
      extensions: { ...config.value.extensions, [KEY]: checkedMerged.value },
    });
    if (!written.ok) return written;
    return this.get(scope);
  }

  async clear(scope: ConfigScope): Promise<OperationResult<PersonalizationSnapshot>> {
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const extensions = { ...config.value.extensions };
    delete extensions[KEY];
    const written = await this.repository.write(scope, { ...config.value, extensions });
    if (!written.ok) return written;
    return this.get(scope);
  }

  async export(scope: ConfigScope): Promise<OperationResult<PortablePersonalization>> {
    const current = await this.get(scope);
    if (!current.ok) return current;
    return { ok: true, value: { schemaVersion: 1, profile: current.value.profile } };
  }

  async import(scope: ConfigScope, value: unknown): Promise<OperationResult<PersonalizationSnapshot>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        (value as Record<string, unknown>).schemaVersion !== 1) {
      return validateProfile(null, 'PERSONALIZATION_IMPORT_INVALID') as OperationResult<PersonalizationSnapshot>;
    }
    const checked = validateProfile(
      (value as Record<string, unknown>).profile,
      'PERSONALIZATION_IMPORT_INVALID',
    );
    if (!checked.ok) return checked;
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const written = await this.repository.write(scope, {
      ...config.value,
      extensions: { ...config.value.extensions, [KEY]: checked.value },
    });
    if (!written.ok) return written;
    return this.get(scope);
  }
}
