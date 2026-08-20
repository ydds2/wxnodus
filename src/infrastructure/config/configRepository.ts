// src/infrastructure/config/configRepository.ts — 配置持久化：原子写（tmp+fsync+rename），YAML/JSON 按扩展名
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { parse, stringify } from 'yaml';
import type { OperationResult } from '../../protocol/results.js';
import {
  configError,
  DEFAULT_CONFIG,
  type ConfigDocument,
  type ConfigScope,
  validateConfigDocument,
} from '../../domain/config/configSchema.js';

export interface ConfigRepositoryOptions { userFile: string; workspaceFile: string }

export class ConfigRepository {
  constructor(private readonly options: ConfigRepositoryOptions) {}

  path(scope: ConfigScope): string {
    return scope === 'user' ? this.options.userFile : this.options.workspaceFile;
  }

  async read(scope: ConfigScope): Promise<OperationResult<ConfigDocument>> {
    const file = this.path(scope);
    if (!existsSync(file)) return { ok: true, value: { ...DEFAULT_CONFIG } };
    try {
      const text = readFileSync(file, 'utf8');
      const raw = ['.yaml', '.yml'].includes(extname(file).toLowerCase()) ? parse(text) : JSON.parse(text);
      return validateConfigDocument(raw);
    } catch (cause) {
      return {
        ok: false,
        error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid', {
          file, cause: String((cause as Error).message ?? cause),
        }),
      };
    }
  }

  async write(scope: ConfigScope, document: ConfigDocument): Promise<OperationResult<ConfigDocument>> {
    const checked = validateConfigDocument(document);
    if (!checked.ok) return checked;
    const file = this.path(scope);
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const text = ['.yaml', '.yml'].includes(extname(file).toLowerCase())
        ? stringify(checked.value)
        : `${JSON.stringify(checked.value, null, 2)}\n`;
      writeFileSync(tmp, text, { encoding: 'utf8', flag: 'w' });
      const fd = openSync(tmp, 'r+'); // Windows：fsync 需要可写句柄（'r' 只读 → EPERM）
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file);
      return this.read(scope);
    } catch (cause) {
      rmSync(tmp, { force: true });
      return {
        ok: false,
        error: configError('CONFIG_ATOMIC_WRITE_FAILED', 'config.write.failed', {
          file, cause: String((cause as Error).message ?? cause),
        }),
      };
    }
  }

  async remove(scope: ConfigScope): Promise<void> {
    rmSync(this.path(scope), { force: true });
  }
}
