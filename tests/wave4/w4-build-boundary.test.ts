// tests/wave4/w4-build-boundary.test.ts — DX-02 构建边界契约（干净 checkout 可复现全绿）
// 锁定：root build 必须链入 ink dist（@wxnodus/ink 的 index.js 是 export * from './dist/entry-exports.js'，
// dist 缺失时全部 UI suites 挂）；clean 不得删除 ink dist（否则 build 链断裂）。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('DX-02 build boundary', () => {
  it('root build chains the ink dist build before tsc', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.scripts.build).toContain('build:ink');
    expect(pkg.scripts.build).toContain('tsc');
    expect(pkg.scripts['build:ink']).toContain('packages/wxnodus-ink');
  });

  it('ink entry resolves through its bundled dist (why the chain exists)', () => {
    const entry = readFileSync(join(root, 'packages/wxnodus-ink/index.js'), 'utf8');
    expect(entry).toContain('dist/entry-exports.js');
  });

  it('root bin still points at the tsc output', () => {
    const pkg = readJson(join(root, 'package.json'));
    expect(pkg.bin.wxnodus).toBe('dist/cli/index.js');
  });
});
