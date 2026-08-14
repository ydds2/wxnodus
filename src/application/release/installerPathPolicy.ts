// src/application/release/installerPathPolicy.ts — P0-03：安装器路径策略（fail-closed）
// 统一拒绝 /、\、..、绝对/drive/UNC、空/点段、Windows 保留名、重复与大小写冲突；
// entry 必须存在于文件闭包内。packager 只消费通过本策略的候选树。
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function validateInstallerPaths(
  files: Iterable<string>,
  entryPath: string,
): OperationResult<void> {
  const seen = new Map<string, string>();
  for (const raw of files) {
    const path = String(raw);
    if (!path || path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path) ||
        path.includes('\\') || path.includes('..') || path.includes('\0')) {
      return { ok: false, error: configError('INSTALLER_PATH_INVALID', 'installer.path.invalid', { path }) };
    }
    const segments = path.split('/');
    if (segments.some(segment => !segment || segment === '.')) {
      return { ok: false, error: configError('INSTALLER_PATH_INVALID', 'installer.path.invalid', { path }) };
    }
    for (const segment of segments) {
      // 白名单字符集：cmd/PS 双层安全（拒绝 %、&、$、`、空格、引号等一切插值字符）
      if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
        return { ok: false, error: configError('INSTALLER_PATH_INVALID', 'installer.path.invalid', { path, segment }) };
      }
      const base = segment.split('.')[0]!.toUpperCase();
      if (WINDOWS_RESERVED.has(base)) {
        return { ok: false, error: configError('INSTALLER_PATH_RESERVED_NAME', 'installer.path.reservedName', { path, segment }) };
      }
    }
    const key = path.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      const code = existing === path ? 'INSTALLER_PATH_DUPLICATE' : 'INSTALLER_PATH_CASE_CONFLICT';
      return { ok: false, error: configError(code, 'installer.path.conflict', { path, existing }) };
    }
    seen.set(key, path);
  }
  if (!seen.has(entryPath.toLowerCase())) {
    return { ok: false, error: configError('INSTALLER_ENTRY_INVALID', 'installer.entry.invalid', { entryPath }) };
  }
  return { ok: true, value: undefined };
}
