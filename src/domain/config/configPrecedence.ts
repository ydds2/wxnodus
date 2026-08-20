// src/domain/config/configPrecedence.ts — locale 优先级：cli > env > workspace > user > default
import type { ConfigSource, Locale } from './configSchema.js';
import { inferSystemLocale, normalizeLocale } from './configSchema.js';

export interface LocaleCandidates {
  cli?: unknown;
  env?: unknown;
  workspace?: unknown;
  user?: unknown;
  systemLocale?: string;
}

export interface ResolvedConfig<T> { value: T; source: ConfigSource }

export function resolveLocalePrecedence(input: LocaleCandidates): ResolvedConfig<Locale> {
  const ordered: Array<[ConfigSource, unknown]> = [
    ['cli', input.cli], ['env', input.env], ['workspace', input.workspace], ['user', input.user],
  ];
  for (const [source, candidate] of ordered) {
    const locale = normalizeLocale(candidate);
    if (locale) return { value: locale, source };
  }
  return { value: inferSystemLocale(input.systemLocale), source: 'default' };
}
