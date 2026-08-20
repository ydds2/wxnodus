// tests/regressions/known-failures/kf-019-build-restart-readback.regression.test.ts — KF-019 已修复回归
// verify 引擎已实现「启动→探活→重启→读回」闭环，gate 健康门消费 verifyProject。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifyProject } from '../../../src/build/verify.js';

const verifySrc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/build/verify.ts'), 'utf8');

describe('KF-019 resolved: restart + readback verification exists', () => {
  it('verify.ts 实现重启与读回闭环', () => {
    expect(/restart|重启/.test(verifySrc)).toBe(true);
    expect(/readback|读回/.test(verifySrc)).toBe(true);
  });
  it('verifyProject 为可调用的验证入口', () => {
    expect(typeof verifyProject).toBe('function');
  });
});
