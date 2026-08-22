// tests/wave4/w4-build-boundary.test.ts — DX-02 构建边界契约（干净 checkout 可复现全绿）
// 2026-08-22 TUI/ink 移除后：构建为单级（clean + tsc）——不再链入任何子包构建；
// bin 直接指向 tsc 产物。本测试锁定「单级、无链式依赖、入口正确」三要点。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('DX-02 build boundary', () => {
  it('root build is single-stage: clean + tsc, no chained package builds', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.scripts.build).toBe('npm run clean && tsc');
    // 反弹回（防再引入链式子包构建）：除显式独立的 vscode-ext 打包入口外，
    // build 类脚本不再链入 workspace 子包，root build 也不得引用 vscode-ext 入口
    for (const [name, script] of Object.entries(pkg.scripts) as Array<[string, string]>) {
      if (name === 'build:vscode-ext') continue; // 独立显式入口（用户手动触发），不入 root 链
      if (!name.startsWith('build')) continue;
      expect(script, name).not.toMatch(/--prefix packages\//);
      expect(script, name).not.toContain('build:vscode-ext');
    }
  });

  it('root bin still points at the tsc output', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.bin.wxnodus).toBe('dist/cli/index.js');
    expect(pkg.bin.wxn).toBe('dist/cli/index.js');
  });
});
