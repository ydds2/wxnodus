// src/domain/sessions/sessionStart.ts — SessionStart 文档契约：会话启动工件（身份/locale/模型/钩子/能力 + canonical sha256 绑定）
// W3 Session 第 1 步：validate 重算 canonical sha256 并比对——全零/漂移哈希一律拒绝
// （此前只校验 64-hex 形态，「0」*64 可通过——绑定形同虚设）。
import { createHash } from 'node:crypto';
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
const SHA256 = /^[a-f0-9]{64}$/;

/** canonical 序列化（键序固定、递归）——generate/validate/persist/read-back 共用的单一事实源 */
export const canonicalSessionStart = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalSessionStart).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalSessionStart(entry)}`).join(',')}}`;
};

export function sessionStartHash(body: Omit<SessionStartDocument, 'sha256'>): string {
  return createHash('sha256').update(canonicalSessionStart(body)).digest('hex');
}

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
      typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
    return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.invalid') };
  }
  // W3：哈希绑定重算比对——全零/字段漂移/任意替换一律拒绝
  const { sha256: _declared, ...body } = raw;
  const recomputed = sessionStartHash(body as Omit<SessionStartDocument, 'sha256'>);
  if (recomputed !== raw.sha256) {
    return { ok: false, error: configError('SESSION_START_HASH_MISMATCH', 'sessionStart.hashMismatch', { declared: raw.sha256, recomputed }) };
  }
  return { ok: true, value: raw as unknown as SessionStartDocument };
}
