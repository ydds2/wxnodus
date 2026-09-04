// src/lib/errorMessage.ts — ⅩⅩⅩⅣ 代码规范化：错误消息提取单一事实源
// 此前 `String((e as Error)?.message ?? e)` 13+ 变体散布全仓。
/** 安全提取 Error.message（非 Error 值原样 String 化——零抛错） */
export function errorMessage(e: unknown): string {
  return String((e as Error | undefined)?.message ?? e)
}

/** 同上 + 截断（热路径用——避免长堆栈消息撑爆日志/通知） */
export function errorMessageBounded(e: unknown, maxLen = 200): string {
  return errorMessage(e).slice(0, maxLen)
}
