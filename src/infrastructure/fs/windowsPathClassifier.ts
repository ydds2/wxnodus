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
  /** V4 P1-7：false 时跳过第三层属性探测（读类工具豁免——attrib 零成本也不必探） */
  attributeProbe?: boolean;
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

// V4 P1-8：归一化升级——尾斜杠剥离 + 小写之外，补 realpathSync.native（展开 8.3 短名
// PROGRA~1 与尾点 Windows.\ 等 Win32 真实可达别名）+ win32.normalize + 统一正斜杠。
// 此前仅小写比对：C:\Windows.\system32\x、C:\PROGRA~1\...、全正斜杠
// 三类别名全部逃过 system-* 强确认（本机实证）降级 other 普通审批。
import { realpathSync } from 'node:fs';
import { basename, dirname, normalize as winNormalize } from 'node:path';

const norm = (p: string): string => {
  // 段尾点/尾空格剥离（Win32 GetFullPathName 语义："Windows." 即 "Windows"——API 级别名）
  const stripped = winNormalize(p).replace(/[.\\/]+$/, '')
    .split('\\').map(seg => seg.replace(/[. ]+$/, '')).join('\\');
  return stripped.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
};

/** realpath 展开的规范形——逐级回退：尾段不存在时解析最深存在祖先的 realpath，
 * 拼回剩余相对段（C:\PROGRA~1\x.dll 中 x.dll 不存在但 PROGRA~1 可展开）。
 * 全程不可解析 → lexical 归一回退。 */
const realNorm = (p: string): string => {
  let node = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return norm(realpathSync.native(node) + (tail.length ? '\\' + tail.join('\\') : ''));
    } catch {
      const parent = dirname(node);
      if (parent === node) return norm(p); // 到根仍不可解析——lexical 回退
      tail.unshift(basename(node));
      node = parent;
    }
  }
};

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
  const tLex = norm(target);
  const tReal = realNorm(target); // V4 P1-8：别名展开形（8.3 短名/尾点/连接点解引用后）

  // 1) 系统目录（WINDIR/Program Files/ProgramData/AppData——前缀匹配；双形任一命中）
  for (const [cls, roots] of systemRoots(env)) {
    for (const root of roots) {
      if (!root) continue;
      const r = norm(root);
      for (const t of [tLex, tReal]) {
        if (t === r || t.startsWith(r + '/')) {
          return { class: cls, path: target, reason: `系统目录：${root}` };
        }
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
  // V4 P1-7：attributeProbe=false（读类工具豁免——第一/二层系统目录与 reparse 判定已足够）
  if (stats.isFile() && opts.attributeProbe !== false) {
    const probe = opts.readAttributes ?? defaultReadAttributes;
    const attr = probe(target, stats.mtimeMs);
    if (attr === 'hidden-or-system-attribute') {
      return { class: 'hidden-or-system-attribute', path: target, reason: '隐藏/系统属性文件' };
    }
    if (attr === 'unavailable') {
      return { class: 'hidden-or-system-attribute', path: target, reason: '属性读取失败——按疑似系统处理（fail-closed）' };
    }
  }
  return { class: 'workspace', path: target };
}

// V4 P1-7：属性探测税废除——attrib（System32 常驻，毫秒级冷启）替代 spawnSync powershell
// （150-800ms/次且阻塞事件循环：每次带 path 的工具调用 decide 阶段都探测，流式输出呈
// 脉冲卡顿）。结果按 path+mtime LRU 缓存（同文件二次调用零 spawn）；读类工具在
// classifyPipelineArgs 侧整体跳过属性探测（仅写类 system-touch 启用第三层）。
const ATTR_CACHE_MAX = 512;
const attrCache = new Map<string, 'hidden-or-system-attribute' | 'plain'>();
/** 测试可观测：attrib 实际 spawn 计数（零 spawn 基准断言用） */
export const attrProbeStats = { spawnCount: 0 };

/** win32 属性探测：attrib 属性位列含 H/S 任一即隐藏/系统；失败 unavailable（fail-closed 上游） */
function defaultReadAttributes(target: string, mtimeKey?: number): 'hidden-or-system-attribute' | 'plain' | 'unavailable' {
  if (process.platform !== 'win32') return 'plain';
  const cacheKey = target.toLowerCase() + '|' + (mtimeKey ?? 0);
  const cached = attrCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    attrProbeStats.spawnCount += 1;
    const r = spawnSync('attrib', [target], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    const out = String(r.stdout ?? '');
    if (r.status !== 0 || !out.trim()) return 'unavailable'; // 不缓存失败（下次重试）
    // attrib 输出形如 "  A  SHR      C:\path\file"——属性位列（路径前的空白分隔段）：
    // 任一属性段（1-4 字母连写，如 SHR/SH/AH）包含 H 或 S 即命中
    const pathStart = out.indexOf(target.charAt(0));
    const flagCols = pathStart > 0 ? out.slice(0, pathStart).toUpperCase() : '';
    const hit: 'hidden-or-system-attribute' | 'plain' = flagCols
      .split(/\s+/)
      .some(seg => /^[A-Z]{1,4}$/.test(seg) && /[HS]/.test(seg))
      ? 'hidden-or-system-attribute' : 'plain';
    attrCache.set(cacheKey, hit);
    if (attrCache.size > ATTR_CACHE_MAX) attrCache.delete(attrCache.keys().next().value as string);
    return hit;
  } catch {
    return 'unavailable';
  }
}

/** 命令字符串是否引用系统根（process.spawn 语义层——shell 命令不受路径边界约束） */
export function commandTouchesSystemPath(command: string, opts: Pick<ClassifyOptions, 'env' | 'platform'> = {}): PathClassification | null {
  if ((opts.platform ?? process.platform) !== 'win32') return null;
  const env = opts.env ?? process.env;
  // V4 P1-8：与 norm 同款归一（小写+反斜杠→正斜杠）——两侧形制一致，includes 语义不漂移
  const text = String(command ?? '').toLowerCase().replace(/\\/g, '/');
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
// V4 P1-7：读类工具豁免集——这些工具的调用跳过属性探测（第三层），仅保留系统目录/reparse/
// 命令扫描判定（读操作无写入面；写类 system-touch 保持三层完整）
const READONLY_PROBE_EXEMPT = new Set(['fs_read', 'ls', 'grep', 'find_files', 'view_image', 'http_get', 'http_request', 'web_search', 'memory_search', 'repo_map', 'lsp_diagnostics', 'lsp_hover', 'lsp_definition', 'command_search', 'tool_search']);

export function classifyPipelineArgs(args: unknown, workspaceRoot: string, opts?: { toolId?: string }): PathClassification | null {
  const shortId = typeof opts?.toolId === 'string' ? opts.toolId.split(':').pop() ?? '' : '';
  const attributeProbe = !READONLY_PROBE_EXEMPT.has(shortId);
  const a = (args ?? {}) as Record<string, unknown>;
  const path = typeof a.path === 'string' ? a.path
    : typeof a.target === 'string' ? a.target
    : typeof a.filePath === 'string' ? a.filePath
    : undefined;
  if (path) {
    const absolutePath = resolve(workspaceRoot, path);
    const c = classifyWindowsPath(absolutePath, { workspaceRoot, attributeProbe });
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
