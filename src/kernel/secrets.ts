// src/kernel/secrets.ts — 敏感数据内存保险库（sudo 密码 / 环境变量密钥）
// 安全红线（用户强制）：
//  ① 敏感内容只由用户亲手输入（UI overlay / 交互通道），绝不落盘、不进消息历史、不进模型上下文
//  ② 关闭注入通道（/security … off）→ 同步清空内存缓存（clearAll）
//  ③ 值仅存内存引用，clear 后置 null；进程退出即消失
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
  /** 全量清除（任一注入通道关闭时调用） */
  clearAll(): void;
}

export function createSecretVault(): SecretVault {
  let sudoPassword: string | null = null;
  const secrets = new Map<string, string>();
  return {
    setSudoPassword(p) { sudoPassword = p; },
    getSudoPassword() { return sudoPassword; },
    clearSudoPassword() { sudoPassword = null; },
    hasSudo() { return sudoPassword !== null; },
    setSecret(name, value) { secrets.set(name, value); },
    getSecret(name) { return secrets.get(name); },
    clearSecrets() { secrets.clear(); },
    secretNames() { return [...secrets.keys()]; },
    clearAll() { sudoPassword = null; secrets.clear(); },
  };
}
