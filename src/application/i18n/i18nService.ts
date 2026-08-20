// src/application/i18n/i18nService.ts — 双语消息服务：zh/en key 集合严格一致，控制流只依赖 key
import type { Locale } from '../../domain/config/configSchema.js';
import { en } from './catalogs/en.js';
import { zhCN } from './catalogs/zh-CN.js';

export type MessageKey = keyof typeof en;
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

export function translate(locale: Locale, key: MessageKey): string {
  return catalogs[locale][key];
}

export function messageKeys(locale: Locale): MessageKey[] {
  return Object.keys(catalogs[locale]).sort() as MessageKey[];
}
