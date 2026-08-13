// src/compat/descriptors.ts — 兼容清单条目构造助手（单一事实源：所有 surface 模块共用）
import type { CompatibilityEntry } from './schema.js';

export function entry(
  kind: CompatibilityEntry['kind'],
  name: string,
  descriptor: Record<string, unknown>,
  disposition: CompatibilityEntry['disposition'] = 'preserve',
  extra?: { replacement?: string; reasonCode?: CompatibilityEntry['reasonCode'] },
): CompatibilityEntry {
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    descriptor,
    disposition,
    ...(extra?.replacement !== undefined ? { replacement: extra.replacement } : {}),
    ...(extra?.reasonCode !== undefined ? { reasonCode: extra.reasonCode } : {}),
  };
}
