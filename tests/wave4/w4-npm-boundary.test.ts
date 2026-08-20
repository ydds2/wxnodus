// tests/wave4/w4-npm-boundary.test.ts — DX-03：npm 打包边界契约
// 正向 files allowlist（仅运行时/metadata/README/LICENSE）；src/tests/docs/scripts/evidence/
// 运行时数据/日志一律不得入包；ink dist 在 workspace 外可解析（index.js → ./dist/entry-exports.js）。
// 真实 `npm pack --dry-run --json --ignore-scripts` 清单逐项校验（绝不只信声明）。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  files?: string[]; bundledDependencies?: string[];
};

describe('DX-03 npm package boundary', () => {
  it('declares a positive-only files allowlist and bundles the private ink workspace package', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files!.length).toBeGreaterThanOrEqual(8);
    // 正向 allowlist：无取反条目
    expect(pkg.files!.some(f => f.startsWith('!'))).toBe(false);
    // 禁止面：src/tests/docs/scripts/证据/数据/日志绝不在 allowlist
    const forbidden = ['src', 'tests', 'docs', 'scripts', 'evidence', 'data', '.superpowers', 'wxdbg.log', 'AGENTS.md'];
    for (const f of forbidden) {
      expect(pkg.files!.includes(f)).toBe(false);
    }
    expect(pkg.bundledDependencies).toContain('@wxnodus/ink');
  });

  it('ink runtime resolves outside the workspace (index.js → dist/entry-exports.js, dist present)', () => {
    const index = readFileSync(join(ROOT, 'packages/wxnodus-ink/index.js'), 'utf8');
    expect(index).toContain('./dist/entry-exports.js');
    expect(existsSync(join(ROOT, 'packages/wxnodus-ink/dist/entry-exports.js'))).toBe(true);
  });

  it('real npm pack manifest contains only the allowlisted surface', async () => {
    // --ignore-scripts：测试不触发 prepack 重建（build 链由 w4-build-boundary 锁定）
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = await execFileAsync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32',
    }).catch((e: NodeJS.ErrnoException & { stdout?: string }) => e);
    expect(result).not.toBeInstanceOf(Error);
    const parsed = JSON.parse(String((result as { stdout: string }).stdout)) as Array<{ files: Array<{ path: string }> }>;
    const files = parsed[0]?.files?.map(f => f.path) ?? [];
    expect(files.length).toBeGreaterThan(20);
    // 必含：运行时入口 + ink dist + 元数据
    for (const required of ['dist/cli/index.js', 'package.json', 'README.md', 'LICENSE', 'packages/wxnodus-ink/package.json', 'packages/wxnodus-ink/dist/entry-exports.js']) {
      expect(files).toContain(required);
    }
    // 必不含：源码/测试/文档/脚本/证据/数据/日志/本机路径
    // node_modules/ 例外：bundledDependencies 把 @wxnodus/ink 及其依赖闭包（第三方已发布内容）
    // 嵌套在包内（安装时落位）——本边界只管本项目表面：@wxnodus/ink 自身 src/test 不得入包。
    const forbiddenPrefix = ['src/', 'tests/', 'docs/', 'scripts/', 'evidence/', 'data/', '.superpowers/', 'wxdbg.log', 'AGENTS.md'];
    for (const file of files) {
      if (file.startsWith('node_modules/')) {
        expect(file).not.toContain('wxnodus/ink/src');
        expect(file).not.toContain('wxnodus/ink/.test');
        continue;
      }
      for (const prefix of forbiddenPrefix) {
        expect(file, `forbidden in pack: ${file}`).not.toMatch(new RegExp(`^${prefix.replace('/', '\\/')}`));
      }
      expect(file).not.toContain('package-lock.json');
    }
    // ink dist 入口真实在包内（workspace 外可解析）
    expect(files).toContain('node_modules/@wxnodus/ink/dist/entry-exports.js');
    expect(files).toContain('node_modules/@wxnodus/ink/index.js');
  }, 240_000);
});
