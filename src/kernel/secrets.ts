// src/kernel/secrets.ts — 敏感数据内存保险库（sudo 密码 / 环境变量密钥）
// 安全红线（用户强制）：
//  ① 敏感内容只由用户亲手输入（UI overlay / 交互通道），绝不落盘、不进消息历史、不进模型上下文
//  ② 关闭注入通道（/security … off）→ 同步清空内存缓存（clearAll）
//  ③ 值仅存内存引用，clear 后置 null；进程退出即消失
//  ④ TTL 空闲过期（P0 完善）：值超过 SECRET_TTL_MS 未被使用即自动清除（惰性检查）
export interface SecretVault {
  /** sudo 密码（会话内缓存——通道关闭即清） */
  setSudoPassword(p: string): void;
  getSudoPassword(): string | null;
  clearSudoPassword(): void;
  hasSudo(): boolean;
  /** 环境变量密钥（name → value） */
  setSecret(name: string, value: string): void;
  getSecret(name: string): string | undefined;
  clearSecrets(): void;
  secretNames(): string[];
  /** 字段剩余有效期（秒；不存在/已过期返回 0）——/security secrets list 展示 */
  secretTTL(name: string): number;
  /** 全量清除（任一注入通道关闭时调用） */
  clearAll(): void;
}

/** 空闲过期时长：值 10 分钟未被使用即自动清除（每次 get 刷新） */
export const SECRET_TTL_MS = 10 * 60 * 1000;

export function createSecretVault(opts: { now?: () => number } = {}): SecretVault {
  const now = opts.now ?? (() => Date.now());
  let sudoPassword: string | null = null;
  let sudoLastUsed = 0;
  const secrets = new Map<string, { value: string; lastUsed: number }>();

  const ttlLeft = (lastUsed: number): number => {
    const left = SECRET_TTL_MS - (now() - lastUsed);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  };

  return {
    setSudoPassword(p) { sudoPassword = p; sudoLastUsed = now(); },
    getSudoPassword() {
      if (sudoPassword === null) return null;
      if (ttlLeft(sudoLastUsed) <= 0) { sudoPassword = null; return null; } // 空闲过期
      sudoLastUsed = now(); // 使用即刷新
      return sudoPassword;
    },
    clearSudoPassword() { sudoPassword = null; },
    hasSudo() { return this.getSudoPassword() !== null; },
    setSecret(name, value) { secrets.set(name, { value, lastUsed: now() }); },
    getSecret(name) {
      const s = secrets.get(name);
      if (!s) return undefined;
      if (ttlLeft(s.lastUsed) <= 0) { secrets.delete(name); return undefined; } // 空闲过期
      s.lastUsed = now(); // 使用即刷新
      return s.value;
    },
    clearSecrets() { secrets.clear(); },
    secretNames() { return [...secrets.keys()]; },
    secretTTL(name) {
      const s = secrets.get(name);
      if (!s) return 0;
      const left = ttlLeft(s.lastUsed);
      if (left <= 0) { secrets.delete(name); return 0; }
      return left;
    },
    clearAll() { sudoPassword = null; secrets.clear(); },
  };
}
