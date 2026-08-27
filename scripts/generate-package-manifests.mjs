#!/usr/bin/env node
// scripts/generate-package-manifests.mjs — 分发闭环 S0：winget/scoop manifest 生成器
// 用法：先 npm run build，再 node scripts/generate-package-manifests.mjs [--zip <installer.zip>] [--url <baseURL>] [--out <dir>]
// 渲染：packaging/{winget,scoop} 模板 × package.json（version/description）→ 正式 manifest。
// winget 输出为 winget-pkgs 三文件形态（version/installer/locale，新包提交必需）。
// 诚实门禁：--zip 提供时计算真实 SHA-256；缺失时 InstallerUrl/InstallerSha256 输出
//           __RELEASE_URL_REQUIRED__/__SHA256_REQUIRED__ 占位并警告「不可提交发布」——
//           绝不生成假装可发布的 manifest。
// 纯函数已抽至 src/application/release/manifestGen.ts（2026-08-18：vitest 在 runner 上
// inline 本 .mjs 的主入口块触发 [eval] SyntaxError——本文件只留 CLI 壳，依赖 dist 构建）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWingetManifest, renderScoopManifest, zipSha256 } from '../dist/application/release/manifestGen.js';

// 兼容旧引用（tests/package-manifest-gen.test.ts 现直连 TS 模块；此再导出仅供脚本面导入）
export { renderWingetManifest, renderScoopManifest, zipSha256 };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  // winget-pkgs 多文件形态（version/installer/locale 三份，新包提交必需）
  const wingetTplDir = join(ROOT, 'packaging', 'winget');
  const wingetVersion = renderWingetManifest(readFileSync(join(wingetTplDir, 'version.template.yaml'), 'utf8'), ctx);
  const wingetInstaller = renderWingetManifest(readFileSync(join(wingetTplDir, 'installer.template.yaml'), 'utf8'), ctx);
  const wingetLocale = renderWingetManifest(readFileSync(join(wingetTplDir, 'locale.zh-CN.template.yaml'), 'utf8'), ctx);
  const scoop = renderScoopManifest(readFileSync(join(ROOT, 'packaging', 'scoop', 'wxnodus.template.json'), 'utf8'), ctx);

  const wingetOutDir = join(outDir, 'winget');
  const scoopOut = join(outDir, 'scoop', `wxnodus.json`);
  mkdirSync(wingetOutDir, { recursive: true });
  mkdirSync(dirname(scoopOut), { recursive: true });
  writeFileSync(join(wingetOutDir, 'yyds2.wxnodus.yaml'), wingetVersion, 'utf8');
  writeFileSync(join(wingetOutDir, 'yyds2.wxnodus.installer.yaml'), wingetInstaller, 'utf8');
  writeFileSync(join(wingetOutDir, 'yyds2.wxnodus.locale.zh-CN.yaml'), wingetLocale, 'utf8');
  writeFileSync(scoopOut, scoop, 'utf8');

  if (!sha256 || !url) {
    console.warn(`WARN: ${!url ? '--url 未提供（InstallerUrl 为占位符）' : ''}${!url && !sha256 ? '；' : ''}${!sha256 ? '--zip 未提供（InstallerSha256 为占位符）' : ''}——manifest 不可提交发布`);
  }
  if (zip && !sha256) console.error('ERROR: 指定了 --zip 但无法读取/计算 SHA-256');
  console.log(`WINGET: ${wingetOutDir}\\yyds2.wxnodus.yaml（+ .installer.yaml / .locale.zh-CN.yaml，三文件形态）`);
  console.log(`SCOOP:  ${scoopOut}`);
  console.log(sha256 ? `SHA256: ${sha256}` : 'SHA256: (未计算)');
  if (existsSync(join(ROOT, 'package.json')) && !zip && !url) process.exitCode = 0; // 模板态合法输出（占位符明确标注）
}
