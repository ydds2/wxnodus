// src/application/extensions/pluginInstaller.ts — /plugin install 第三方插件接收（2026-08-18，S-02 接收侧）
// 用户口径：暂缓公开市场托管——「能接收到市场插件，下载第三方即可」。
// 支持三类来源：本地目录（plugin.json + index.js）/ 本地 zip / https(s) URL（zip）。
// 安全面：
//   - URL 下载走 ctx.download（checkUrlSafety 逐跳授权 SSRF 三层 + 流式原子落盘 + sha256 证据）
//   - 解包条目逐路径校验（拒绝 ../ 与绝对路径穿越）
//   - manifest 经 parsePluginManifest 校验（非法名/损坏清单拒绝）
//   - 可选 --sha256 来源完整性校验（不符拒绝）；未提供时诚实提示未校验
//   - staging 原子 rename 落位；enable 失败回滚（绝不残留半装插件）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { readZip } from '../release/zipArchive.js';
import { parsePluginManifest } from '../../kernel/plugins.js';

export interface PluginInstallInput {
  /** 来源：本地目录 / 本地 zip 路径 / https URL */
  source: string;
  /** 数据根（插件落位 dataDir/plugins/<name>/） */
  dataDir: string;
  /** 可选：期望的 zip SHA-256（hex）——不符拒绝 */
  expectedSha256?: string;
  /** URL 下载（生产注入 ctx.download——SSRF 防护已在其中）；返回落盘路径与字节数 */
  download?: (url: string) => Promise<{ filePath: string; bytes: number }>;
  /** 启用回调（生产注入 pluginLifecycleService.enable——沙箱门/owned scope）；返回是否启用成功 */
  enable?: (installedDir: string) => Promise<{ ok: boolean; detail?: string }>;
}

export interface PluginInstallResult {
  ok: true;
  name: string;
  version: string;
  toolCount: number;
  sourceSha256: string | null;
  sha256Verified: boolean;
  enabled: boolean;
  note?: string;
}

export type PluginInstallOutcome = PluginInstallResult | { ok: false; code: string; message: string };

const sha256Hex = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const isLocalZip = (s: string) => /\.zip$/i.test(s.trim());

/** 解包条目路径安全校验：拒绝绝对路径与 ../ 穿越 */
function safeEntryPath(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split('/');
  if (parts.some(p => p === '..' || p === '')) return null;
  return parts.join(sep);
}

/** 从 zip 提取插件两文件；支持根级或单层目录布局 */
function extractPluginZip(buf: Buffer): { files: Map<string, Buffer>; sha256: string } | { error: string } {
  const zip = readZip(buf);
  if (!zip.ok) return { error: `ZIP_CORRUPT（${zip.error.code}）` };
  const entries = zip.value;
  // 布局归一：全部条目在单层目录下 → 剥前缀
  const top = new Set<string>();
  for (const p of entries.keys()) top.add(p.split('/')[0]!);
  const prefix = top.size === 1 && !entries.has('plugin.json') && !entries.has('index.js') ? `${[...top][0]!}/` : '';
  const files = new Map<string, Buffer>();
  for (const [p, content] of entries) {
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (rel === 'plugin.json' || rel === 'index.js') files.set(rel, content);
  }
  if (!files.has('plugin.json')) return { error: '包内缺少 plugin.json' };
  if (!files.has('index.js')) return { error: '包内缺少 index.js' };
  return { files, sha256: sha256Hex(buf) };
}

/** /plugin install 核心：来源解析 → 校验 → 原子落位 → 启用（可回滚） */
export async function installPluginPackage(input: PluginInstallInput): Promise<PluginInstallOutcome> {
  const { source, dataDir } = input;
  let zipBuf: Buffer | null = null;
  let files: Map<string, Buffer> | null = null;
  let sourceSha256: string | null = null;

  if (isUrl(source)) {
    if (!input.download) return { ok: false, code: 'PLUGIN_INSTALL_NO_DOWNLOAD', message: '当前组合根未装配下载通道——URL 来源不可用' };
    try {
      const dl = await input.download(source);
      zipBuf = readFileSync(dl.filePath);
    } catch (e: any) {
      return { ok: false, code: 'PLUGIN_INSTALL_DOWNLOAD_FAILED', message: `下载失败：${String(e?.message ?? e)}` };
    }
    const extracted = extractPluginZip(zipBuf);
    if ('error' in extracted) return { ok: false, code: 'PLUGIN_INSTALL_BAD_PACKAGE', message: extracted.error };
    files = extracted.files;
    sourceSha256 = extracted.sha256;
  } else if (isLocalZip(source)) {
    try { zipBuf = readFileSync(source); } catch { return { ok: false, code: 'PLUGIN_INSTALL_SOURCE_MISSING', message: `找不到 zip：${source}` }; }
    const extracted = extractPluginZip(zipBuf);
    if ('error' in extracted) return { ok: false, code: 'PLUGIN_INSTALL_BAD_PACKAGE', message: extracted.error };
    files = extracted.files;
    sourceSha256 = extracted.sha256;
  } else {
    // 本地目录
    try {
      files = new Map([
        ['plugin.json', readFileSync(join(source, 'plugin.json'))],
        ['index.js', readFileSync(join(source, 'index.js'))],
      ]);
    } catch {
      return { ok: false, code: 'PLUGIN_INSTALL_SOURCE_MISSING', message: `目录缺少 plugin.json / index.js：${source}` };
    }
  }

  // manifest 校验（非法名/损坏清单在此拒绝）
  let manifest: ReturnType<typeof parsePluginManifest>;
  try {
    manifest = parsePluginManifest(files.get('plugin.json')!.toString('utf8'));
  } catch (e: any) {
    return { ok: false, code: 'PLUGIN_MANIFEST_INVALID', message: `plugin.json 无效：${String(e?.message ?? e)}` };
  }
  const name = manifest.name;

  // sha256 校验（zip 来源才可比对；目录来源无包哈希语义）
  if (input.expectedSha256) {
    if (!sourceSha256) return { ok: false, code: 'PLUGIN_INSTALL_SHA256_MISMATCH', message: '目录来源无包哈希——--sha256 仅适用于 zip/URL 包' };
    if (sourceSha256 !== input.expectedSha256.toLowerCase()) {
      return { ok: false, code: 'PLUGIN_INSTALL_SHA256_MISMATCH', message: `SHA-256 不符：期望 ${input.expectedSha256}，实际 ${sourceSha256}` };
    }
  }

  // 落位（原子：staging → rename；enable 失败回滚）
  const pluginsRoot = join(dataDir, 'plugins');
  mkdirSync(pluginsRoot, { recursive: true });
  const target = join(pluginsRoot, name);
  if (existsSync(target)) {
    return { ok: false, code: 'PLUGIN_ALREADY_INSTALLED', message: `插件已安装：${name}——/plugin uninstall ${name} 后重装` };
  }
  const staging = join(pluginsRoot, `.staging-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    mkdirSync(staging, { recursive: true });
    for (const [rel, content] of files) {
      const safe = safeEntryPath(rel);
      if (!safe) { rmSync(staging, { recursive: true, force: true }); return { ok: false, code: 'PLUGIN_INSTALL_PATH_UNSAFE', message: `包内路径不安全：${rel}` }; }
      writeFileSync(join(staging, safe), content);
    }
    renameSync(staging, target);
  } catch (e: any) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return { ok: false, code: 'PLUGIN_INSTALL_STAGING_FAILED', message: `落位失败：${String(e?.message ?? e)}` };
  }

  // 启用（沙箱门/owned scope 由 lifecycle 承担）；失败回滚落位
  let enabled = false;
  let enableNote: string | undefined;
  if (input.enable) {
    const en = await input.enable(target);
    enabled = en.ok;
    enableNote = en.detail;
    if (!en.ok) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return { ok: false, code: 'PLUGIN_INSTALL_ENABLE_FAILED', message: `安装已回滚——启用失败：${en.detail ?? '未知原因'}` };
    }
  }

  return {
    ok: true,
    name,
    version: manifest.version,
    toolCount: (manifest.tools ?? []).length,
    sourceSha256,
    sha256Verified: !!input.expectedSha256,
    enabled,
    note: input.expectedSha256
      ? (enableNote ?? undefined)
      : `来源完整性未校验（未提供 --sha256，包 sha256=${sourceSha256 ?? 'N/A'}）——建议提供发布方哈希后重装校验${enableNote ? `；${enableNote}` : ''}`,
  };
}
