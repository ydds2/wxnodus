// src/kernel/dynamicForm.ts — 动态内容表（敏感输入，仅内存）
// 设计：需要敏感信息时在 CLI 动态生成字段表（多字段掩码表单），用户交互输入——
//       像对话时输入 key 一样；结果仅存内存 vault（不落盘/不进历史/不进模型上下文），
//       以 $WXNODUS_SECRET_<字段名> 占位符供 bash 等工具展开；进程退出即失。
import type { SecretVault } from './secrets.js';

export interface FormField {
  name: string;
  label?: string;
  /** text（明文显示可选）/ password（掩码）/ key（长密钥掩码） */
  kind: 'text' | 'password' | 'key';
}

export interface FormRequest {
  requestId: string;
  fields: FormField[];
  prompt?: string;
}

export interface FormResponse {
  ok: boolean;
  message: string;
  /** 已录入字段名（不返回值——值仅存 vault） */
  fields?: string[];
}

// ── 内容表展开：$WXNODUS_SECRET_<NAME> → vault 值（复用 secrets 通道的展开机制）──
/** 从文本中提取引用的敏感字段名（$WXNODUS_SECRET_<NAME>） */
export function extractSecretRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/\$WXNODUS_SECRET_([A-Za-z0-9_]+)/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

/**
 * 录入表单结果到内存 vault（仅内存——不写盘、不进历史）。
 * 返回已录入字段；重复字段名覆盖（用户重新输入 = 更新）。
 */
export function commitFormValues(vault: SecretVault, values: Record<string, string>, fields: FormField[]): string[] {
  const committed: string[] = [];
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || v === null) continue;
    vault.setSecret(f.name, String(v));
    committed.push(f.name);
  }
  return committed;
}

/** 校验表单响应完整性：全部必填字段都有值 */
export function validateFormResponse(values: Record<string, string>, fields: FormField[]): string[] {
  const missing = fields.filter(f => {
    const v = values[f.name];
    return v === undefined || v === null || String(v).trim() === '';
  }).map(f => f.name);
  return missing;
}
