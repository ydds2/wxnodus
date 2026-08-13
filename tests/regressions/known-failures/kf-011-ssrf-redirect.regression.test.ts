// tests/regressions/known-failures/kf-011-ssrf-redirect.regression.test.ts — KF-011 已修复回归
// checkUrlSafety 已拒绝非 http(s) scheme（file:// 等），重定向逐跳校验亦已实现。
import { describe, expect, it } from 'vitest';
import { checkUrlSafety } from '../../../src/kernel/ssrf.js';

describe('KF-011 resolved: scheme-level SSRF guard', () => {
  it('file:// 等非 http(s) scheme 直接拦截', async () => {
    expect((await checkUrlSafety('file:///C:/Windows/system32/config/SAM')).ok).toBe(false);
    expect((await checkUrlSafety('file:///etc/passwd')).ok).toBe(false);
  });
  it('私网/保留段 http 目标仍拦截', async () => {
    expect((await checkUrlSafety('http://127.0.0.1:8080/x')).ok).toBe(false);
    expect((await checkUrlSafety('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
  });
});
