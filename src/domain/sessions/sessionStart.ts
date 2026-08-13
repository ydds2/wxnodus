// src/domain/sessions/sessionStart.ts — SessionStart 文档契约：会话启动工件（身份/locale/模型/钩子/能力 + canonical sha256 绑定）
import type { Locale } from '../config/configSchema.js';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../config/configSchema.js';

export interface SessionStartHook { id: string; kind: 'on-session-start'; enabled: boolean }
export interface SessionStartDocument {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  locale: Locale;
  model: string;
  dataDir: string;
  hooks: SessionStartHook[];
  capabilities: string[];
  /** canonical 哈希绑定以上全部字段（防漂移） */
  sha256: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateSessionStart(value: unknown): OperationResult<SessionStartDocument> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.invalid') };
  }
  const raw = value as Record<string, unknown>;
  const localeValid = raw.locale === 'zh-CN' || raw.locale === 'en';
  const hooksValid = Array.isArray(raw.hooks) && raw.hooks.every(hook =>
    typeof hook === 'object' && hook !== null &&
    typeof (hook as SessionStartHook).id === 'string' && SAFE_ID.test((hook as SessionStartHook).id) &&
    (hook as SessionStartHook).kind === 'on-session-start' && typeof (hook as SessionStartHook).enabled === 'boolean');
  const capabilitiesValid = Array.isArray(raw.capabilities) && raw.capabilities.length > 0 &&
    raw.capabilities.every(item => typeof item === 'string' && item.length > 0);
  if (raw.schemaVersion !== 1 || typeof raw.sessionId !== 'string' || !SAFE_ID.test(raw.sessionId) ||
      typeof raw.createdAt !== 'string' || !localeValid || typeof raw.model !== 'string' || !raw.model ||
      typeof raw.dataDir !== 'string' || !raw.dataDir || !hooksValid || !capabilitiesValid ||
      typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
    return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.invalid') };
  }
  return { ok: true, value: raw as unknown as SessionStartDocument };
}
