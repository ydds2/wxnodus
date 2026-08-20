// src/infrastructure/fs/windowsPathClassifier.ts — W7-02：Windows 系统路径分类器（感知+确认层）
// 分类系统目录/隐藏·系统属性文件/reparse 点——供管线 decide 阶段强制专属确认（system-touch）；
// 只读探测；属性读取失败 → 按「疑似系统」fail-closed（绝不因探测失败而放行）。
// 非 win32：诚实返回 'other'（非 Windows 无系统目录语义——降级为普通审批，绝不假装有保护）。
import { lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

export type SystemPathClass =
  | 'system-windows'
  | 'system-programs'
  | 'system-programdata'
  | 'user-appdata'
  | 'hidden-or-system-attribute'
  | 'reparse-point'
  | 'workspace'
  | 'other';

export interface PathClassification {
  class: SystemPathClass;
  path: string;
  /** system-touch 需确认的理由（确认弹窗展示） */
  reason?: string;
}

export interface ClassifyOptions {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** 属性探测（隐藏/系统位）——win32 经 PowerShell 真实读取；注入供测试 */
  readAttributes?(target: string): 'hidden-or-system-attribute' | 'plain' | 'unavailable';
}

export type WindowsResourceNameClass =
  | 'ordinary'
  | 'unc'
  | 'extended-unc'
  | 'device-namespace'
  | 'nt-namespace'
  | 'alternate-data-stream'
  | 'drive-relative'
  | 'reserved-device-name';

export type WindowsResourceNameClassification =
  | { allowed: true; class: 'ordinary'; path: string }
  | { allowed: false; class: Exclude<WindowsResourceNameClass, 'ordinary'>; path: string; reason: string };

const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;

/**
 * Pure Win32 resource-name policy. The workspace boundary accepts local DOS-drive
 * paths only; network and object-manager namespaces are never workspace aliases.
 */
export function classifyWindowsResourceName(target: string): WindowsResourceNameClassification {
  const path = String(target ?? '');
  const winPath = path.replace(/\//g, '\\');
  const lower = winPath.toLowerCase();
  const reject = (resourceClass: Exclude<WindowsResourceNameClass, 'ordinary'>, reason: string): WindowsResourceNameClassification => ({
    allowed: false,
    class: resourceClass,
    path,
    reason,
  });

  if (lower.startsWith('\\\\?\\unc\\')) {
    return reject('extended-unc', 'extended UNC paths are outside the local workspace policy');
  }
  if (
    lower.startsWith('\\\\?\\globalroot\\')
    || lower.startsWith('\\\\.\\globalroot\\')
    || /^(?:\\globalroot|\\global\?\?|\\dosdevices|\\device)\\/i.test(winPath)
  ) {
    return reject('nt-namespace', 'NT object-manager and global aliases are not workspace paths');
  }
  if (lower.startsWith('\\\\?\\') || lower.startsWith('\\\\.\\')) {
    return reject('device-namespace', 'Win32 device namespaces are not workspace paths');
  }
  if (/^(?:\\\\|\\)(?:\?\?|globalroot|global\?\?|dosdevices|device)\\/i.test(winPath)) {
    return reject('nt-namespace', 'NT object-manager aliases are not workspace paths');
  }
  if (winPath.startsWith('\\\\')) {
    return reject('unc', 'UNC paths are outside the local workspace policy');
  }
  if (/^[a-z]:(?!\\)/i.test(winPath)) {
    return reject('drive-relative', 'drive-relative paths depend on per-drive process state');
  }

  const colon = winPath.indexOf(':');
  if (colon !== -1 && (colon !== 1 || winPath.indexOf(':', colon + 1) !== -1)) {
    return reject('alternate-data-stream', 'alternate data streams are not workspace files');
  }

  const start = /^[a-z]:\\/i.test(winPath) ? 3 : 0;
  for (const component of winPath.slice(start).split('\\')) {
    if (!component) continue;
    const withoutWin32Suffix = component.replace(/[ .]+$/g, '');
    const basename = (withoutWin32Suffix.split('.', 1)[0] ?? '').replace(/ +$/g, '');
    if (RESERVED_DEVICE_NAME.test(basename)) {
      return reject('reserved-device-name', `reserved Windows device name: ${component}`);
    }
  }

  return { allowed: true, class: 'ordinary', path };
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();

/** 系统根候选（大小写不敏感前缀匹配；Windows 驱动器字母亦不敏感） */
function systemRoots(env: Record<string, string | undefined>): Array<[SystemPathClass, string[]]> {
  const win = env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows';
  const programs = env.ProgramFiles ?? 'C:\\Program Files';
  const programsX86 = env['ProgramFiles(x86)'];
  const programData = env.ProgramData ?? 'C:\\ProgramData';
  const localAppData = env.LOCALAPPDATA;
  return [
    ['system-windows', [win]],
    ['system-programs', [programs, ...(programsX86 ? [programsX86] : [])]],
    ['system-programdata', [programData]],
    ['user-appdata', [...(localAppData ? [localAppData] : []), ...(env.APPDATA ? [env.APPDATA] : [])]],
  ];
}

export function classifyWindowsPath(target: string, opts: ClassifyOptions): PathClassification {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') {
    return { class: 'other', path: target, reason: '非 Windows 无系统目录语义（诚实降级普通审批）' };
  }
  if (!target || !isAbsolute(target)) {
    return { class: 'other', path: target };
  }
  const t = norm(target);

  // 1) 系统目录（WINDIR/Program Files/ProgramData/AppData——前缀匹配）
  for (const [cls, roots] of systemRoots(env)) {
    for (const root of roots) {
      if (!root) continue;
      const r = norm(root);
      if (t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')) {
        return { class: cls, path: target, reason: `系统目录：${root}` };
      }
    }
  }

  // 2) 工作区内（先判 reparse 再判属性——junction/symlink 逃逸优先于属性）
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return { class: 'other', path: target }; // 不存在/不可读 → other（边界层另行拒绝）
  }
  if (stats.isSymbolicLink()) {
    return { class: 'reparse-point', path: target, reason: '符号链接/junction（可能逃逸工作区）' };
  }
  const rel = relative(resolve(opts.workspaceRoot), resolve(target));
  const insideWorkspace = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!insideWorkspace) {
    return { class: 'other', path: target }; // 工作区外非系统路径 → 边界层（pathBoundary）处理
  }

  // 3) 隐藏/系统属性（工作区内文件）——win32 真实属性探测，失败按疑似系统 fail-closed
  if (stats.isFile()) {
    const probe = opts.readAttributes ?? defaultReadAttributes;
    const attr = probe(target);
    if (attr === 'hidden-or-system-attribute') {
      return { class: 'hidden-or-system-attribute', path: target, reason: '隐藏/系统属性文件' };
    }
    if (attr === 'unavailable') {
      return { class: 'hidden-or-system-attribute', path: target, reason: '属性读取失败——按疑似系统处理（fail-closed）' };
    }
  }
  return { class: 'workspace', path: target };
}

/** win32 属性探测：PowerShell Get-Item -Force Attributes（HIDDEN/SYSTEM 位） */
function defaultReadAttributes(target: string): 'hidden-or-system-attribute' | 'plain' | 'unavailable' {
  if (process.platform !== 'win32') return 'plain';
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${String(target).replace(/'/g, "''")}' -Force).Attributes -band 6`], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    const out = String(r.stdout ?? '').trim();
    if (r.status !== 0 || !/^\d+$/.test(out)) return 'unavailable';
    return (Number(out) & 6) !== 0 ? 'hidden-or-system-attribute' : 'plain';
  } catch {
    return 'unavailable';
  }
}

/** 命令字符串是否引用系统根（process.spawn 语义层——shell 命令不受路径边界约束） */
export function commandTouchesSystemPath(command: string, opts: Pick<ClassifyOptions, 'env' | 'platform'> = {}): PathClassification | null {
  if ((opts.platform ?? process.platform) !== 'win32') return null;
  const env = opts.env ?? process.env;
  const text = String(command ?? '').toLowerCase();
  for (const [cls, roots] of systemRoots(env)) {
    for (const root of roots) {
      if (!root) continue;
      if (text.includes(norm(root))) return { class: cls, path: text, reason: `命令引用系统目录：${root}` };
    }
  }
  return null;
}

/** 管线 args → system-touch 分类（path/target/filePath 字段分类 + command 字段系统根引用）；
 * 返回 null = 无 system-touch（workspace/other 走普通策略流） */
export function classifyPipelineArgs(args: unknown, workspaceRoot: string): PathClassification | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const path = typeof a.path === 'string' ? a.path
    : typeof a.target === 'string' ? a.target
    : typeof a.filePath === 'string' ? a.filePath
    : undefined;
  if (path) {
    const absolutePath = resolve(workspaceRoot, path);
    const c = classifyWindowsPath(absolutePath, { workspaceRoot });
    if (c.class !== 'workspace' && c.class !== 'other') return c;
  }
  if (typeof a.executable === 'string') {
    const hit = commandTouchesSystemPath([a.executable, ...(Array.isArray(a.args) ? a.args.map(String) : [])].join(' '));
    if (hit) return hit;
  }
  if (typeof a.command === 'string') {
    const hit = commandTouchesSystemPath(a.command);
    if (hit) return hit;
  }
  return null;
}
