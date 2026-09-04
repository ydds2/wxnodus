// tests/wave4/w4-build-boundary.test.ts — DX-02 构建边界契约（干净 checkout 可复现全绿）
// C-2（2026-08-30）：@wxnodus/ink fork 退役（05274b34 用户裁决「用成熟组件」的收口）——
// src/tui 全部 import 上游 ink 6，fork 不再进依赖表/构建链/发布 files。本测试锁定新边界。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('DX-02 build boundary', () => {
  it('root build is clean + tsc + package dist chains (no fork build step)', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.scripts.build).toContain('tsc');
    expect(pkg.scripts.build).not.toContain('build:ink');
    expect(pkg.scripts.build).toContain('build:sdk');
    expect(pkg.scripts.build).toContain('build:core');
  });

  it('@wxnodus/ink fork fully retired from manifest (dual source of truth eliminated)', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.dependencies['@wxnodus/ink']).toBeUndefined();
    expect(pkg.bundledDependencies).toBeUndefined();
    expect(pkg.bundleDependencies).toBeUndefined();
    expect(JSON.stringify(pkg.files)).not.toContain('wxnodus-ink');
  });

  it('TUI renders on upstream ink (single source of truth)', () => {
    const tuiEntry = readFileSync(join(root, 'src/tui/index.tsx'), 'utf8');
    expect(tuiEntry).toContain("from 'ink'");
    expect(tuiEntry).not.toContain('@wxnodus/ink');
  });

  it('root bin still points at the tsc output', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.bin.wxnodus).toBe('dist/cli/index.js');
  });
});
