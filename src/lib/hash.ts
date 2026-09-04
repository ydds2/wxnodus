// src/lib/hash.ts — ⅩⅩⅩⅣ 代码规范化：哈希工具单一事实源
// 此前 `sha256` 单行函数 ≥10 处定义（签名各异）。本模块提供三种签名重载。
import { createHash, type Hash } from 'node:crypto'

/** sha256(string) → hex 小写 */
export function sha256(data: string): string

/** sha256(Buffer) → hex 小写 */
export function sha256(data: Buffer): string

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** sha512(string) → hex 小写 */
export function sha512(data: string | Buffer): string {
  return createHash('sha512').update(data).digest('hex')
}

/** sha256 但返回 Hash 对象（需要链式 update 的场景——如流式计算） */
export function sha256Stream(): Hash {
  return createHash('sha256')
}

/** isRecord 类型守卫（≥3 处重复定义合并） */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
