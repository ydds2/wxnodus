// src/kernel/redact.ts — 敏感形状脱敏（P1：审批回显/日志防密钥泄露，自研）
// 思路对齐 Hermes _redact_approval_command：审批面板、notice、日志展示前，
// 对「疑似凭据形状」的字符串打码——形状匹配非精确判定，宁可多打码不泄露
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // OpenAI/DeepSeek 风格 sk-…
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, label: '密钥' },
  // GitHub token
  { re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g, label: 'GitHub Token' },
  // AWS Access Key
  { re: /\bAKIA[0-9A-Z]{16}/g, label: 'AWS Key' },
  // Bearer / Basic 令牌
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, label: 'Bearer 令牌' },
  // JWT（三段落 base64url）
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, label: 'JWT' },
  // 常见密钥赋值形状：KEY=xxx / password: xxx
  { re: /\b(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{6,}/gi, label: '凭据字段' },
  // 长 base64（≥32 字符，疑似编码凭据）
  { re: /\b[A-Za-z0-9+/]{32,}={0,2}\b/g, label: '编码凭据' },
];

export interface RedactResult {
  text: string;
  hits: Array<{ label: string; index: number }>;
}

/** 对文本中的疑似凭据形状打码；返回脱敏文本与命中记录（审计留痕） */
export function redactSecrets(text: string): RedactResult {
  if (!text) return { text: '', hits: [] };
  let out = text;
  const hits: Array<{ label: string; index: number }> = [];
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const idx = m.index;
      const full = m[0];
      // 打码：保留前 3 与后 2 字符，中间替换为 ***
      const masked = full.length > 8
        ? full.slice(0, 3) + '***' + full.slice(-2)
        : '***';
      hits.push({ label, index: idx });
      out = out.slice(0, idx) + masked + out.slice(idx + full.length);
      re.lastIndex = idx + masked.length;
    }
  }
  return { text: out, hits };
}
