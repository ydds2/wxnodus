// src/application/legacy/legacyGuard.ts — 遗留路径守护：compat 委托默认启用；显式禁用后任何直接构造遗留驱动即 LEGACY_PATH_DISABLED
// （W3-11：入口层禁止 direct Voice/Build/Computer driver——全部经 compat 委托，且委托可整体断电）
import type { OperationResult } from '../../protocol/results.js';

let legacyEnabled = true;

export const setLegacyPathsEnabled = (enabled: boolean): void => { legacyEnabled = enabled; };
export const areLegacyPathsEnabled = (): boolean => legacyEnabled;

export function assertLegacyPath(path: string): OperationResult<void> {
  if (legacyEnabled) return { ok: true, value: undefined };
  return {
    ok: false,
    error: {
      code: 'LEGACY_PATH_DISABLED',
      message: `legacy path disabled: ${path}`,
      messageKey: 'LEGACY_PATH_DISABLED',
      retryable: false,
      details: { path },
    },
  };
}

/** compat 委托内部使用：禁用时抛 LEGACY_PATH_DISABLED（在任何驱动构造之前） */
export function requireLegacyPath(path: string): void {
  const allowed = assertLegacyPath(path);
  if (!allowed.ok) throw Object.assign(new Error(allowed.error.code), { code: allowed.error.code, details: allowed.error.details });
}
