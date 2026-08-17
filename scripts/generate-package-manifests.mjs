#!/usr/bin/env node
// scripts/generate-package-manifests.mjs — 分发闭环 S0：winget/scoop manifest 生成器
// 用法：node scripts/generate-package-manifests.mjs [--zip <installer.zip>] [--url <baseURL>] [--out <dir>]
// 渲染：packaging/{winget,scoop} 模板 × package.json（version/description）→ 正式 manifest。
// 诚实门禁：--zip 提供时计算真实 SHA-256；缺失时 InstallerUrl/InstallerSha256 输出
//           __RELEASE_URL_REQUIRED__/__SHA256_REQUIRED__ 占位并警告「不可提交发布」——
//           绝不生成假装可发布的 manifest。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 纯函数（可单测）────────────────────────────────────────

/** 渲染 winget manifest（模板占位符替换）。url/sha256 缺省时输出占位符。 */
export function renderWingetManifest(template, ctx) {
  return template
    .replaceAll('__VERSION__', ctx.version)
    .replaceAll('__DESCRIPTION__', ctx.description)
    .replaceAll('__INSTALLER_URL__', ctx.url ?? '__RELEASE_URL_REQUIRED__')
    .replaceAll('__INSTALLER_SHA256__', ctx.sha256 ?? '__SHA256_REQUIRED__');
}

/** 渲染 scoop manifest（JSON 模板——用占位替换后仍为合法 JSON 文档）。 */
export function renderScoopManifest(template, ctx) {
  return template
    .replaceAll('__VERSION__', ctx.version)
    .replaceAll('__DESCRIPTION__', ctx.description)
    .replaceAll('__HOMEPAGE__', ctx.homepage ?? 'https://github.com/yyds2/wxnodus')
    .replaceAll('__INSTALLER_URL__', ctx.url ?? '__RELEASE_URL_REQUIRED__')
    .replaceAll('__INSTALLER_SHA256__', ctx.sha256 ?? '__SHA256_REQUIRED__');
}

/** zip 文件 SHA-256（纯函数可单测）；文件缺失返回 null。 */
export function zipSha256(zipPath, readFile = p => { try { return readFileSync(p); } catch { return null; } }) {
  const buf = readFile(zipPath);
  if (!buf) return null;
  return createHash('sha256').update(buf).digest('hex');
}

// ── CLI 入口 ────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const zip = flag('--zip');
  const url = flag('--url');
  const outDir = resolve(flag('--out') ?? join(ROOT, 'packaging'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  const sha256 = zip ? zipSha256(resolve(zip)) : null;
  const ctx = {
    version: pkg.version,
    description: (pkg.description ?? 'WxNodus').slice(0, 120),
    url: url ?? null,
    sha256,
  };
  const winget = renderWingetManifest(readFileSync(join(ROOT, 'packaging', 'winget', 'manifest.template.yaml'), 'utf8'), ctx);
  const scoop = renderScoopManifest(readFileSync(join(ROOT, 'packaging', 'scoop', 'wxnodus.template.json'), 'utf8'), ctx);

  const wingetOut = join(outDir, 'winget', `wxnodus.${pkg.version}.yaml`);
  const scoopOut = join(outDir, 'scoop', `wxnodus.json`);
  mkdirSync(dirname(wingetOut), { recursive: true });
  mkdirSync(dirname(scoopOut), { recursive: true });
  writeFileSync(wingetOut, winget, 'utf8');
  writeFileSync(scoopOut, scoop, 'utf8');

  if (!sha256 || !url) {
    console.warn(`WARN: ${!url ? '--url 未提供（InstallerUrl 为占位符）' : ''}${!url && !sha256 ? '；' : ''}${!sha256 ? '--zip 未提供（InstallerSha256 为占位符）' : ''}——manifest 不可提交发布`);
  }
  if (zip && !sha256) console.error('ERROR: 指定了 --zip 但无法读取/计算 SHA-256');
  console.log(`WINGET: ${wingetOut}`);
  console.log(`SCOOP:  ${scoopOut}`);
  console.log(sha256 ? `SHA256: ${sha256}` : 'SHA256: (未计算)');
  if (existsSync(join(ROOT, 'package.json')) && !zip && !url) process.exitCode = 0; // 模板态合法输出（占位符明确标注）
}
