// src/domain/quality/evidenceStorePort.ts — 证据存储品牌端口（audit §13.45 分层泄漏修复）
// domain 不再直 import infrastructure 的 FileEvidenceStore 类。防伪模型：
//   品牌值 = 构造时创建的闭包，捕获真实 store 实例的私有 WeakSet（#receipts 不可外部访问）——
//   子类覆写公共 owns 方法无法影响验证（gate 只经品牌闭包），伪造对象拿不到闭包。
import type { VerifiedEvidenceReceipt } from './evidence.js';

export const EVIDENCE_STORE_BRAND: unique symbol = Symbol('wxnodus.evidenceStore');

export interface EvidenceStorePort {
  readonly [EVIDENCE_STORE_BRAND]: { owns(receipt: unknown): boolean };
}

export function isGenuineEvidenceStore(value: unknown): value is EvidenceStorePort {
  if (typeof value !== 'object' || value === null) return false;
  const brand = (value as { [EVIDENCE_STORE_BRAND]?: unknown })[EVIDENCE_STORE_BRAND] as { owns?: unknown } | null | undefined;
  return typeof brand === 'object' && brand !== null && typeof brand.owns === 'function';
}

/** 经品牌闭包验证收据归属（绕过子类 owns 覆写——p0-completion-authority 契约） */
export function evidenceStoreOwns(store: EvidenceStorePort, receipt: unknown): receipt is VerifiedEvidenceReceipt {
  return store[EVIDENCE_STORE_BRAND].owns(receipt);
}
