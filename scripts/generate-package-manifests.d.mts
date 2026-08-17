// scripts/generate-package-manifests.d.mts — 类型声明（.mjs 脚本的 TS 导入面）
// TS7016 修复：tests/package-manifest-gen.test.ts 导入本脚本，缺声明导致隐式 any。
export function renderWingetManifest(template: string, ctx: { version: string; description?: string; url?: string; sha256?: string }): string;
export function renderScoopManifest(template: string, ctx: { version: string; description?: string; homepage?: string; url?: string; sha256?: string }): string;
export function zipSha256(zipPath: string, readFile?: (p: string) => Buffer | null): Promise<string>;
