// src/domain/safeNames.ts — 安全名称校验：穿越/绝对路径/分隔符/控制字符/Windows 保留名/NFKC-case 冲突
import { canonicalIdentifier } from './identifiers.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok } from '../protocol/results.js';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validateSafeName(input: string, existing: readonly string[]) {
  const normalized = input.normalize('NFKC');
  if (normalized === '..' || normalized.split(/[\\/]/).includes('..')) {
    return err(gatewayError('SAFE_NAME_TRAVERSAL', '名称包含路径穿越', 'safe_name.traversal'));
  }
  if (/^[a-z]:/i.test(normalized) || /^\\\\/.test(normalized) || normalized.startsWith('/')) {
    return err(gatewayError('SAFE_NAME_ABSOLUTE_PATH', '名称不能是绝对路径', 'safe_name.absolute_path'));
  }
  if (/[\\/]/.test(normalized)) {
    return err(gatewayError('SAFE_NAME_SEPARATOR', '名称不能包含路径分隔符', 'safe_name.separator'));
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return err(gatewayError('SAFE_NAME_CONTROL_CHAR', '名称不能包含控制字符', 'safe_name.control_char'));
  }
  if (/[. ]$/.test(normalized)) {
    return err(gatewayError('SAFE_NAME_TRAILING_DOT_SPACE', '名称不能以点或空格结尾', 'safe_name.trailing_dot_space'));
  }
  if (RESERVED.test(normalized)) {
    return err(gatewayError('SAFE_NAME_WINDOWS_RESERVED', '名称是 Windows 保留名', 'safe_name.windows_reserved'));
  }
  const key = canonicalIdentifier(normalized);
  if (existing.some(item => canonicalIdentifier(item) === key)) {
    return err(gatewayError('SAFE_NAME_COLLISION', '名称在 NFKC/case 归一化后冲突', 'safe_name.collision'));
  }
  return ok(normalized);
}

/** W2-07：扩展名（Skill/Plugin 共用同一实现）——NFKC 恒等、字符集、Windows 保留名、结尾点/空格 */
export function assertSafeExtensionName(value: string): void {
  const normalized = value.normalize('NFKC');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    normalized !== value
    || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)
    || value.includes('..')
    || reserved.test(value)
    || /[. ]$/.test(value)
  ) {
    throw Object.assign(new Error(`UNSAFE_EXTENSION_NAME:${value}`), { code: 'UNSAFE_EXTENSION_NAME' });
  }
}
