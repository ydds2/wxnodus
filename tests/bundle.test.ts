
// V4 P5-3：版本指纹与兼容校验（只收不出收口——bundle 是唯一外发通道）
import { describe, it, expect } from 'vitest';
import { bundleVersionOk } from '../src/kernel/bundle.js';
describe('bundleVersionOk 版本兼容判定（P5-3）', () => {
  it('下限≤当前 → true；下限>当前 → false', () => {
    expect(bundleVersionOk('3.0.0', '4.0.0')).toBe(true);
    expect(bundleVersionOk('4.0.0', '4.0.0')).toBe(true);
    expect(bundleVersionOk('4.0.1', '4.0.0')).toBe(false);
    expect(bundleVersionOk('5.0.0', '4.9.9')).toBe(false);
    expect(bundleVersionOk('v4.0.0', '4.0.0')).toBe(true); // v 前缀容忍
  });
  it('非法声明视为兼容（不误拒旧包）', () => {
    expect(bundleVersionOk('garbage', '4.0.0')).toBe(true);
    expect(bundleVersionOk('', '4.0.0')).toBe(true);
  });
});
