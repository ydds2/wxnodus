// tests/kernel-version.test.ts — 版本单一事实源（改版本只动 package.json，全仓显示处自动同步）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('WXNODUS_VERSION 单一事实源', () => {
  it('运行时版本与 package.json version 一致', async () => {
    const { WXNODUS_VERSION } = await import('../src/kernel/version.js');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(WXNODUS_VERSION).toBe(pkg.version);
  });
  it('版本已从 3.0.0 升级（用户可感更新）', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).not.toBe('3.0.0');
  });
});
