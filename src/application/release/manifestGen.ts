// src/application/release/manifestGen.ts — winget/scoop manifest 渲染纯函数（分发闭环 S0）
// 从 scripts/generate-package-manifests.mjs 抽取（2026-08-18 CI 十轮：vitest 在 runner 上
// inline 该 .mjs 的主入口块触发 [eval] SyntaxError——纯函数归 TS 模块，.mjs 只留 CLI 壳）。
// 诚实门禁契约：url/sha256 缺失时输出 __*_REQUIRED__ 占位符（绝不生成假装可发布的 manifest）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface ManifestGenContext {
  version: string;
  description?: string;
  homepage?: string;
  url?: string;
  sha256?: string;
}

/** 渲染 winget manifest（模板占位符替换）。url/sha256 缺省时输出占位符。 */
export function renderWingetManifest(template: string, ctx: ManifestGenContext): string {
  return template
    .replaceAll('__VERSION__', ctx.version)
    .replaceAll('__DESCRIPTION__', ctx.description ?? '')
    .replaceAll('__INSTALLER_URL__', ctx.url ?? '__RELEASE_URL_REQUIRED__')
    .replaceAll('__INSTALLER_SHA256__', ctx.sha256 ?? '__SHA256_REQUIRED__');
}

/** 渲染 scoop manifest（JSON 模板——用占位替换后仍为合法 JSON 文档）。 */
export function renderScoopManifest(template: string, ctx: ManifestGenContext): string {
  return template
    .replaceAll('__VERSION__', ctx.version)
    .replaceAll('__DESCRIPTION__', ctx.description ?? '')
    .replaceAll('__HOMEPAGE__', ctx.homepage ?? 'https://github.com/yyds2/wxnodus')
    .replaceAll('__INSTALLER_URL__', ctx.url ?? '__RELEASE_URL_REQUIRED__')
    .replaceAll('__INSTALLER_SHA256__', ctx.sha256 ?? '__SHA256_REQUIRED__');
}

/** zip 文件 SHA-256（纯函数可单测）；文件缺失返回 null。 */
export function zipSha256(zipPath: string, readFile: (p: string) => Buffer | null = p => { try { return readFileSync(p); } catch { return null; } }): string | null {
  const buf = readFile(zipPath);
  if (!buf) return null;
  return createHash('sha256').update(buf).digest('hex');
}
