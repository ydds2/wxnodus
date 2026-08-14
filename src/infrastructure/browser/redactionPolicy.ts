// src/infrastructure/browser/redactionPolicy.ts — W5-02 预存储脱敏（事件进入内存前执行）
// URL userinfo 与敏感 query（token/access_token/refresh_token/api_key/client_secret/signature/code…）
// 在落内存/evidence 前即删除；无法安全 parse → 拒绝（fail-closed：绝不带病存储）。
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export const SENSITIVE_QUERY_KEYS: readonly string[] = [
  'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'api-key', 'key',
  'client_secret', 'secret', 'password', 'passwd', 'pwd',
  'signature', 'sig', 'sign',
  'code', 'auth', 'authorization', 'credential', 'credentials',
];

// 脱敏占位（URL-safe：WHATWG URL 序列化会编码 []，用纯字母标记避免二次歧义）
export const REDACTED_VALUE = 'REDACTED';

export interface RedactionResult {
  url: string;
  redactedKeys: string[];
}

/** 脱敏：userinfo 全删 + 敏感 query 值替换；解析失败/非 http(s) → 拒绝 */
export function redactHarUrl(raw: string): OperationResult<RedactionResult> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: configError('HAR_CAPTURE_INVALID', 'har.capture.url.unparseable') };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: configError('HAR_CAPTURE_INVALID', 'har.capture.url.scheme') };
  }
  // 1) userinfo（user:pass@）——任何存在即整段删除
  parsed.username = '';
  parsed.password = '';
  // 2) 敏感 query 键（大小写不敏感）→ 值替换
  const redactedKeys: string[] = [];
  const sensitive = SENSITIVE_QUERY_KEYS.map(k => k.toLowerCase());
  for (const key of [...parsed.searchParams.keys()]) {
    if (sensitive.includes(key.toLowerCase())) {
      redactedKeys.push(key);
      parsed.searchParams.set(key, REDACTED_VALUE);
    }
  }
  return { ok: true, value: { url: parsed.toString(), redactedKeys } };
}
