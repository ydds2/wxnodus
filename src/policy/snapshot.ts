// src/policy/snapshot.ts — Policy Manifest 构建与字节级验证（fail-closed 消费者合同）
import { createHash } from 'node:crypto';
import { NORMATIVE_REDLINE_CATALOG } from './catalog.js';
import { policyRuleSources } from '../kernel/permissions.js';
import type { PolicyManifest, PolicyRuleDescriptor, NormativeRedlineCategory } from './schema.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(rules: PolicyRuleDescriptor[]): string {
  return createHash('sha256').update(canonical(rules)).digest('hex');
}

export function buildPolicyManifest(): PolicyManifest {
  const rules = policyRuleSources().map(rule => ({
    id: rule.id,
    version: rule.version,
    kind: rule.kind,
    category: rule.category,
    descriptionKey: rule.descriptionKey,
    source: rule.source,
    overrideable: rule.overrideable,
    requiresUserPresence: rule.requiresUserPresence,
    matcher: rule.matcher,
  }));
  return {
    schemaVersion: 1,
    catalogVersion: 1,
    categories: NORMATIVE_REDLINE_CATALOG.map(category => ({
      id: category.id,
      normative: category.normative,
      descriptionKey: category.descriptionKey,
    })),
    rules,
    checksum: checksum(rules),
  };
}

const CATEGORY_IDS = new Set<NormativeRedlineCategory>(NORMATIVE_REDLINE_CATALOG.map(c => c.id));
const RULE_KINDS = new Set(['hard_redline', 'sensitive_write', 'command_redline']);
const MATCHER_TYPES = new Set(['regex', 'path', 'command']);

function isValidManifest(value: unknown): value is PolicyManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<PolicyManifest>;
  if (m.schemaVersion !== 1 || m.catalogVersion !== 1) return false;
  if (!Array.isArray(m.categories) || m.categories.some(c => !c || c.normative !== true || !CATEGORY_IDS.has(c.id))) return false;
  if (!Array.isArray(m.rules)) return false;
  for (const rule of m.rules) {
    if (!rule || typeof rule !== 'object') return false;
    if (typeof rule.id !== 'string' || !rule.id) return false;
    if (typeof rule.version !== 'number') return false;
    if (!RULE_KINDS.has(rule.kind)) return false;
    if (!CATEGORY_IDS.has(rule.category)) return false;
    if (typeof rule.descriptionKey !== 'string' || !rule.descriptionKey) return false;
    if (typeof rule.source !== 'string' || !rule.source) return false;
    if (rule.overrideable !== false) return false;
    if (typeof rule.requiresUserPresence !== 'boolean') return false;
    const matcher = rule.matcher;
    if (!matcher || !MATCHER_TYPES.has(matcher.type)) return false;
    if (typeof matcher.value !== 'string') return false;
    if (matcher.type === 'regex' && typeof matcher.flags !== 'string') return false;
  }
  return typeof m.checksum === 'string' && m.checksum.length === 64;
}

export type PolicyVerifyResult =
  | { ok: true; manifest: PolicyManifest }
  | { ok: false; code: 'POLICY_PARSE_FAILED' | 'POLICY_SCHEMA_INVALID' | 'POLICY_CHECKSUM_MISMATCH' };

/** 字节级验证：parse → schema → checksum；顺序固定，失败即 fail-closed */
export function verifyPolicyManifestBytes(bytes: Uint8Array | Buffer): PolicyVerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { ok: false, code: 'POLICY_PARSE_FAILED' };
  }
  if (!isValidManifest(parsed)) return { ok: false, code: 'POLICY_SCHEMA_INVALID' };
  if (checksum(parsed.rules) !== parsed.checksum) return { ok: false, code: 'POLICY_CHECKSUM_MISMATCH' };
  return { ok: true, manifest: parsed };
}
