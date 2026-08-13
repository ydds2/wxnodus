// src/compat/configSurface.ts — 配置面冻结：settings 键表 / 分区 / 密钥槽位
import { SETTINGS_KEYS } from '../store/config.js';
import { entry } from './descriptors.js';
import type { CompatibilityEntry } from './schema.js';

const SENSITIVE_KEYS = new Set(['apiKeyEnc']);

export function configSurface(): CompatibilityEntry[] {
  const out: CompatibilityEntry[] = [];

  for (const key of [...SETTINGS_KEYS].sort()) {
    out.push(entry('config', `settings:${key}`, {
      partition: 'settings',
      sensitive: SENSITIVE_KEYS.has(key),
      // knownSettingsKeys() 刻意排除 apiKeyEnc：清单仍记录其存在，但永不导出密钥值
      exposedByKnownKeysApi: !SENSITIVE_KEYS.has(key),
    }));
  }

  out.push(entry('config', 'partition-file', { pattern: 'data/<partition>.json', write: 'tmp+rename atomic' }));
  out.push(entry('config', 'read-missing', { behavior: 'returns {}' }));
  out.push(entry('config', 'read-corrupt', { behavior: 'silently returns {}' }, 'deprecate', {
    reasonCode: 'fail_open_security',
    replacement: 'CONFIG_CORRUPT 稳定错误（Wave 0 W0-05）',
  }));
  out.push(entry('config', 'dotted-path', { support: 'getKey/setKey dot paths' }));
  out.push(entry('config', 'unknown-key-policy', { behavior: 'warn on unknown settings key' }));

  return out;
}
