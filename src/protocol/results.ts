// src/protocol/results.ts — OperationResult：单次操作成功 ≠ Run 完成（Run 状态见 runs.ts）
import type { GatewayError } from './errors.js';

export type OperationResult<T> =
  | { ok: true; value: T; evidenceIds?: string[] }
  | { ok: false; error: GatewayError; evidenceIds?: string[] };

export const ok = <T>(value: T, evidenceIds?: string[]): OperationResult<T> => ({ ok: true, value, evidenceIds });
export const err = <T = never>(error: GatewayError, evidenceIds?: string[]): OperationResult<T> => ({ ok: false, error, evidenceIds });
