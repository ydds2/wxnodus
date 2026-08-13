// src/domain/personalization/personalization.ts — 个性化档案：校验/snapshot/可移植导出（stable code，无本地化文本）
import { createHash } from 'node:crypto';
import type { ConfigScope, Locale } from '../config/configSchema.js';
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export interface PersonalizationProfile {
  displayName?: string;
  persona?: string;
  theme?: string;
  locale?: Locale;
  modelPolicy?: { preferredModel?: string; allowRemote: boolean };
  toolPolicy?: { approvalMode: 'always' | 'policy' | 'never' };
  voice?: { enabled: false; voiceId?: string };
  memory?: { enabled: boolean; retention: 'session' | 'persistent' };
}

export interface PersonalizationSnapshot {
  scope: ConfigScope;
  revision: string;
  profile: PersonalizationProfile;
}

export interface PortablePersonalization {
  schemaVersion: 1;
  profile: PersonalizationProfile;
}

function error(code: 'PERSONALIZATION_SCHEMA_INVALID' | 'PERSONALIZATION_IMPORT_INVALID'): GatewayError {
  return { code, message: code, messageKey: code, retryable: false };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProfile(
  value: unknown,
  code: 'PERSONALIZATION_SCHEMA_INVALID' | 'PERSONALIZATION_IMPORT_INVALID' = 'PERSONALIZATION_SCHEMA_INVALID',
): OperationResult<PersonalizationProfile> {
  if (!plainRecord(value)) return { ok: false, error: error(code) };
  const allowed = new Set(['displayName', 'persona', 'theme', 'locale', 'modelPolicy', 'toolPolicy', 'voice', 'memory']);
  if (Object.keys(value).some(key => !allowed.has(key))) return { ok: false, error: error(code) };
  for (const key of ['displayName', 'persona', 'theme'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return { ok: false, error: error(code) };
  }
  if (value.locale !== undefined && value.locale !== 'zh-CN' && value.locale !== 'en') {
    return { ok: false, error: error(code) };
  }
  if (value.modelPolicy !== undefined) {
    if (!plainRecord(value.modelPolicy) || typeof value.modelPolicy.allowRemote !== 'boolean' ||
        (value.modelPolicy.preferredModel !== undefined && typeof value.modelPolicy.preferredModel !== 'string')) {
      return { ok: false, error: error(code) };
    }
  }
  if (value.toolPolicy !== undefined) {
    if (!plainRecord(value.toolPolicy) ||
        !['always', 'policy', 'never'].includes(String(value.toolPolicy.approvalMode))) {
      return { ok: false, error: error(code) };
    }
  }
  if (value.voice !== undefined) {
    if (!plainRecord(value.voice) || value.voice.enabled !== false ||
        (value.voice.voiceId !== undefined && typeof value.voice.voiceId !== 'string')) {
      return { ok: false, error: error(code) };
    }
  }
  if (value.memory !== undefined) {
    if (!plainRecord(value.memory) || typeof value.memory.enabled !== 'boolean' ||
        !['session', 'persistent'].includes(String(value.memory.retention))) {
      return { ok: false, error: error(code) };
    }
  }
  return { ok: true, value: structuredClone(value) as PersonalizationProfile };
}

export function snapshot(scope: ConfigScope, profile: PersonalizationProfile): PersonalizationSnapshot {
  const canonical = JSON.stringify(profile, Object.keys(profile).sort());
  return { scope, profile: structuredClone(profile), revision: createHash('sha256').update(canonical).digest('hex') };
}
