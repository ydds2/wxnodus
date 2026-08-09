// src/kernel/providers.ts — L2-1 模型提供商层
// 设计：OpenAI 兼容 chat API（流式 SSE）+ AES-256-GCM 密钥加密（凭证安全红线，明文绝不落盘/回显）
//      + 规则脑兜底（无 key 诚实回答）+ 关键词路由降级链 + HTTP 错误中文映射
// 参考：OpenAI API 规范、Claude Code 的 credential 安全实践、Gemini CLI 多 provider 模式
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

// ── 密钥加密（AES-256-GCM，机器指纹派生 key）─────────────────
// 格式：enc1:<iv hex>:<tag hex>:<cipher hex>——密钥来自机器指纹（不可移植，防拷贝泄露）
function machineFingerprint(): string {
  const os = require('node:os') as typeof import('node:os');
  return os.hostname() + '::' + os.platform() + '::' + os.arch() + '::' + os.userInfo().username;
}

const encKey = (): Buffer => scryptSync(machineFingerprint(), 'wxnodus-v3', 32);

export function encryptKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptKey(stored: string): string | null {
  try {
    const [tag, ivHex, authHex, dataHex] = stored.split(':');
    if (tag !== 'enc1') return null;
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null; // 篡改/密钥不匹配：返回 null 不抛
  }
}

// ── 规则脑（无 key 兜底：确定性诚实回答，绝不假装智能）─────────
// 能力边界：打招呼 / 简单计算 / 说明状态；其余诚实告知未配置
export function ruleBrain(input: string): string {
  const s = input.trim();
  if (!s) return '（空输入）';
  if (/^(你好|hi|hello|在吗|嗨)/i.test(s)) {
    return '你好！我是 WxNodus（本地概念编译器）。当前未配置模型密钥——说「/key <你的密钥>」配置后即可获得完整能力；未配置时我只能做确定性的简单回答。';
  }
  // 简单四则运算（从中文句中提取表达式，仅数字与 +-*() 空格，防注入）
  const exprMatch = s.match(/[\d\s+\-*/().]{2,}/);
  if (exprMatch && /[+\-*/]/.test(exprMatch[0])) {
    const expr = exprMatch[0].trim();
    if (/^[\d\s+\-*/().]+$/.test(expr)) {
      try {
        const v = Function(`"use strict"; return (${expr});`)();
        if (typeof v === 'number' && Number.isFinite(v)) return `= ${v}`;
      } catch { /* 落入下方兜底 */ }
    }
  }
  return '未配置模型密钥，超出规则脑能力。配置方式：/key <密钥> 或 /key set <密钥>。';
}

// ── 关键词路由（多端点降级链）───────────────────────────────
export interface Route { match: RegExp; endpoint: string; model: string }

export function routeByKeywords(text: string, routes: Route[]): Route | null {
  for (const r of routes) if (r.match.test(text)) return r;
  return null;
}

// ── 请求构造（OpenAI 兼容 /chat/completions）────────────────
export interface ChatMessage { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; tool_call_id?: string }

export function buildChatRequest(opts: {
  baseURL: string; model: string; key: string;
  messages: ChatMessage[]; stream: boolean;
  tools?: unknown[]; temperature?: number;
}) {
  const base = opts.baseURL.replace(/\/+$/, '');
  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  return {
    url: `${base}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
  };
}

// ── HTTP 错误中文映射 ──────────────────────────────────────
export function mapHttpError(status: number): string {
  switch (status) {
    case 400: return '请求格式错误（400）——参数不合法';
    case 401: return '密钥无效或未配置（401）——检查 /key';
    case 402: return '账户余额不足（402）——需充值';
    case 403: return '无权限访问该模型（403）';
    case 404: return '接口或模型不存在（404）——检查 baseURL 与 model';
    case 413: return '请求过大（413）——上下文超限，建议 /compact';
    case 429: return '请求限流（429）——稍后重试或降级模型';
    case 500: return '模型服务端错误（500）';
    case 503: return '服务暂不可用（503）——自动重试中';
    default: return `请求失败（HTTP ${status}）`;
  }
}

// ── 密钥脱敏（日志/审计安全：绝不回显明文）──────────────────
export function maskKey(k: string): string {
  if (!k) return '(未配置)';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

// 便捷：SHA-256（供审计指纹等）
export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
