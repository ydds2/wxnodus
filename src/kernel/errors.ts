// src/kernel/errors.ts — P1-3 协议错误码体系（Hermes 式 4xxx/5xxx 分段，自研定义）
// 4xxx 请求语义错误（调用方可修正）｜5xxx 系统失败（重试或上报）
export const WX_ERR = {
  // 4xxx 请求语义
  UNKNOWN_METHOD: 4001,
  BUSY: 4009,                 // agent 运行中（对齐 hermes 4009 语义）
  INVALID_PARAMS: 4010,
  NOT_FOUND: 4020,
  NO_KEY: 4030,               // 未配置密钥
  RATE_LIMITED: 4029,         // 429
  // 5xxx 系统失败
  INTERNAL: 5001,
  PROVIDER_ERROR: 5020,       // 模型服务 5xx
  NETWORK: 5030,              // 网络/超时
} as const;

export type WxErrorCode = typeof WX_ERR[keyof typeof WX_ERR];

/** 协议错误（RPC 响应携带 code/message，可被客户端区分处理） */
export class WxError extends Error {
  code: WxErrorCode;
  constructor(code: WxErrorCode, message: string) {
    super(message);
    this.name = 'WxError';
    this.code = code;
  }
}

/** 退出码协议（P1-2，对齐 Kimi 0/1/75）：0 成功｜1 不可重试｜75 可重试（429/5xx/网络/超时）
 * C-4（2026-08-30）结构化优先：WxError 数值码 / HTTP status / errno·undici code / cause 链（≤2 层）
 * 先于消息文本嗅探——文本正则只作无结构化信息时的兜底（上游纯消息错误仍走原语义，行为不变）。
 */
export function exitCodeForError(e: unknown): number {
  const seen = new Set<unknown>();
  const structuredRetryable = (x: unknown, depth: number): boolean | null => {
    if (!x || typeof x !== 'object' || depth > 2 || seen.has(x)) return null;
    seen.add(x);
    if (x instanceof WxError) {
      return x.code === WX_ERR.RATE_LIMITED || x.code === WX_ERR.PROVIDER_ERROR || x.code === WX_ERR.NETWORK;
    }
    const o = x as Record<string, unknown>;
    const status = o['status'] ?? o['statusCode'];
    if (typeof status === 'number') {
      if (status === 429 || status >= 500) return true;
      if (status >= 400 && status < 500) return false;
    }
    const code = o['code'];
    if (typeof code === 'string' && /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|UND_ERR_)/.test(code)) return true;
    if (o['cause'] !== undefined) {
      const nested = structuredRetryable(o['cause'], depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  const structured = structuredRetryable(e, 0);
  if (structured !== null) return structured ? 75 : 1;
  // 文本兜底（无结构化信息的纯消息错误——语义与既有行为一致）
  const msg = String(e instanceof Error ? e.message : e);
  if (/429|限流|rate|too many/i.test(msg)) return 75;
  if (/5\d\d|500|502|503|504|服务暂不可用|模型服务端错误/i.test(msg)) return 75;
  if (/timeout|超时|ETIMEDOUT|ECONNRESET|网络|network|fetch failed|UND_ERR/i.test(msg)) return 75;
  return 1;
}

/** 判定错误是否可重试（供 75 退出码与内部重试共用） */
export function isRetryableError(e: unknown): boolean {
  return exitCodeForError(e) === 75;
}
