// src/kernel/fileCrypto.ts — /encrypt 真实文件加解密（2026-08-19「不真实修」：
// 此前 /encrypt 仅状态展示却挂着「加密工具」描述——现真实实现）
// 格式（二进制）：'WXENC1' | salt(16) | iv(12) | tag(16) | ciphertext
// 算法：scrypt（N=16384,r=8,p=1）口令派生 256 位密钥 + AES-256-GCM 认证加密——篡改即解密失败（诚实报错）。
// 口令来自 --key 参数或 WXNODUS_ENC_KEY 环境变量——不落盘、不回显。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('WXENC1', 'ascii');
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface FileCryptoResult { ok: boolean; data?: Buffer; error?: string }

const deriveKey = (pass: string, salt: Buffer) => scryptSync(pass, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

/** 加密：明文 → WXENC1 封装（salt+iv+tag+ciphertext） */
export function encryptBytes(plain: Buffer, pass: string): FileCryptoResult {
  try {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ok: true, data: Buffer.concat([MAGIC, salt, iv, tag, encrypted]) };
  } catch (e: any) {
    return { ok: false, error: `加密失败：${String(e?.message ?? e)}` };
  }
}

/** 解密：WXENC1 封装 → 明文；口令错/篡改 → 诚实失败（GCM 认证拒绝） */
export function decryptBytes(wrapped: Buffer, pass: string): FileCryptoResult {
  try {
    if (wrapped.length < MAGIC.length + 16 + 12 + 16 || !wrapped.subarray(0, MAGIC.length).equals(MAGIC)) {
      return { ok: false, error: '不是 WXENC1 加密文件（或文件损坏）' };
    }
    const salt = wrapped.subarray(MAGIC.length, MAGIC.length + 16);
    const iv = wrapped.subarray(MAGIC.length + 16, MAGIC.length + 28);
    const tag = wrapped.subarray(MAGIC.length + 28, MAGIC.length + 44);
    const body = wrapped.subarray(MAGIC.length + 44);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return { ok: true, data: plain };
  } catch {
    return { ok: false, error: '解密失败：口令错误或文件被篡改（GCM 认证拒绝）' };
  }
}
