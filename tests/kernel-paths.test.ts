// tests/kernel-paths.test.ts — 数据目录解析：WXNODUS_DATA_DIR env 覆盖
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveDataDir } from '../src/kernel/paths.js';

describe('resolveDataDir', () => {
  it('无 env → <cwd>/data（历史约定）', () => {
    expect(resolveDataDir('C:/proj', {})).toBe(join('C:/proj', 'data'));
  });
  it('WXNODUS_DATA_DIR 覆盖数据目录（多实例/换目录无需改代码）', () => {
    expect(resolveDataDir('C:/proj', { WXNODUS_DATA_DIR: 'D:/wxn-data' })).toBe('D:/wxn-data');
  });
  it('空串 env 视为未设置', () => {
    expect(resolveDataDir('C:/proj', { WXNODUS_DATA_DIR: '  ' })).toBe(join('C:/proj', 'data'));
  });
});
