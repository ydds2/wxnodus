// tests/wave4/w4-npm-boundary.test.ts — DX-03：npm 打包边界契约
// 正向 files allowlist（仅运行时 dist/metadata/README/LICENSE）；src/tests/docs/scripts/evidence/
// 运行时数据/日志一律不得入包。2026-08-22 TUI/ink 移除后不再打包任何 workspace 子包。
// 真实 `npm pack --dry-run --json --ignore-scripts` 清单逐项校验（绝不只信声明）。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  files?: string[]; bundledDependencies?: string[]; bundleDependencies?: string[]; dependencies?: Record<string, string>;
};

describe('DX-03 npm package boundary', () => {
  it('declares a positive-only files allowlist without bundled workspace packages', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files!.length).toBeGreaterThanOrEqual(3);
    // 正向 allowlist：无取反条目
    expect(pkg.files!.some(f => f.startsWith('!'))).toBe(false);
    // 禁止面：src/tests/docs/scripts/证据/数据/日志绝不在 allowlist
    const forbidden = ['src', 'tests', 'docs', 'scripts', 'evidence', 'data', '.superpowers', 'wxdbg.log', 'AGENTS.md', 'packages'];
    for (const f of forbidden) {
      expect(pkg.files!.includes(f)).toBe(false);
    }
    // 2026-08-22：@wxnodus/ink 已随 TUI 移除——不得再声明任何 bundled 依赖
    expect(pkg.bundledDependencies ?? pkg.bundleDependencies).toBeUndefined();
    expect(JSON.stringify(pkg.dependencies ?? {})).not.toContain('@wxnodus/ink');
  });

  it('real npm pack manifest contains only the allowlisted surface', async () => {
    // --ignore-scripts：测试不触发 prepack 重建（build 契约由 w4-build-boundary 锁定）
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = await execFileAsync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32',
    }).catch((e: NodeJS.ErrnoException & { stdout?: string }) => e);
    expect(result).not.toBeInstanceOf(Error);
    const parsed = JSON.parse(String((result as { stdout: string }).stdout)) as Array<{ files: Array<{ path: string }> }>;
    const files = parsed[0]?.files?.map(f => f.path) ?? [];
    expect(files.length).toBeGreaterThan(10);
    // 必含：运行时入口 + 元数据
    for (const required of ['dist/cli/index.js', 'package.json', 'README.md', 'LICENSE']) {
      expect(files).toContain(required);
    }
    // 必不含：源码/测试/文档/脚本/证据/数据/日志/本机路径/workspace 子包
    const forbiddenPrefix = ['src/', 'tests/', 'docs/', 'scripts/', 'evidence/', 'data/', '.superpowers/', 'wxdbg.log', 'AGENTS.md', 'packages/', 'node_modules/'];
    for (const file of files) {
      for (const prefix of forbiddenPrefix) {
        expect(file, `forbidden in pack: ${file}`).not.toMatch(new RegExp(`^${prefix.replace('/', '\/')}`));
      }
      expect(file).not.toContain('package-lock.json');
    }
  }, 240_000);
});
