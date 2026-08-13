// src/application/release/installerManifest.ts — 安装器/打包器雏形最小版（「独立艺术品」发行形态的合同层）：
// 应用名净化（Windows 非法字符）+ 入口 sha256 绑定 + 版本 → 安装器 manifest
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export interface InstallerManifest {
  schemaVersion: 1;
  appName: string;
  version: string;
  icon: string | null;
  entryPath: string;
  entrySha256: string;
}

// Windows 文件名非法字符 + 控制字符（显式字符集判定——正则字面量内斜杠转义易出错）
const UNSAFE_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const isUnsafeNameChar = (char: string) =>
  UNSAFE_CHARS.has(char) || (char >= '\u0000' && char <= '\u001f') || char === '\u007f';
// 入口路径允许平台分隔符（/、\）与盘符冒号——路径字符集比名称字符集宽
const PATH_SEPARATORS = new Set(['/', '\\', ':']);
const isUnsafeEntryPathChar = (char: string) =>
  !PATH_SEPARATORS.has(char) && isUnsafeNameChar(char);
const SEMVER = /^\d+\.\d+\.\d+$/;

/** 应用名净化：剥离 Windows 非法字符，空/纯非法 → INSTALLER_NAME_INVALID */
export function sanitizeAppName(name: string): OperationResult<string> {
  const cleaned = [...name].filter(char => !isUnsafeNameChar(char)).join('').trim();
  if (!cleaned || cleaned.length > 64) {
    return { ok: false, error: configError('INSTALLER_NAME_INVALID', 'installer.name.invalid', { name }) };
  }
  return { ok: true, value: cleaned };
}

export function buildInstallerManifest(input: {
  appName: string;
  version: string;
  icon: string | null;
  entryPath: string;
  entryBytes: Buffer;
}): OperationResult<InstallerManifest> {
  const name = sanitizeAppName(input.appName);
  if (!name.ok) return name;
  if (!SEMVER.test(input.version)) {
    return { ok: false, error: configError('INSTALLER_VERSION_INVALID', 'installer.version.invalid', { version: input.version }) };
  }
  if (!input.entryPath || [...input.entryPath].some(isUnsafeEntryPathChar)) {
    return { ok: false, error: configError('INSTALLER_ENTRY_INVALID', 'installer.entry.invalid') };
  }
  const entrySha256 = createHash('sha256').update(input.entryBytes).digest('hex');
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      appName: name.value,
      version: input.version,
      icon: input.icon ?? null,
      entryPath: input.entryPath,
      entrySha256,
    },
  };
}
