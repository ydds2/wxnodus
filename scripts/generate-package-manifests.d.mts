// scripts/generate-package-manifests.d.mts — 类型声明（.mjs 脚本的 TS 导入面）
// 纯函数已抽至 src/application/release/manifestGen.ts（2026-08-18 vitest runner [eval]
// SyntaxError 修复）——此处仅再导出其类型面，保持旧导入路径不破。
export { renderWingetManifest, renderScoopManifest, zipSha256, type ManifestGenContext } from '../src/application/release/manifestGen.js';
