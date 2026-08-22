// 会话 id 校验（SESSION_ID）：旧 3.2 子会话「:sub」兼容 + 穿越/设备名/非法形态拒绝
import { describe, it, expect } from 'vitest';
import { isSessionIdentifier } from '../src/protocol/runs.js';

describe('isSessionIdentifier（用户实战回归：旧子会话冒号兼容）', () => {
  it('旧 3.2 子会话形态「<sid>:sub」放行（2026-08-21 实战：TUI 恢复会话炸 SESSION_ID_INVALID 根因）', () => {
    expect(isSessionIdentifier('s17871837097201:sub')).toBe(true);
    expect(isSessionIdentifier('default')).toBe(true);
    expect(isSessionIdentifier('s1.a-b_c')).toBe(true);
  });
  it('穿越/ADS/设备名/大写/空串仍拒（安全语义不回退）', () => {
    expect(isSessionIdentifier('../evil')).toBe(false);
    expect(isSessionIdentifier('con')).toBe(false);
    expect(isSessionIdentifier('com1')).toBe(false);
    expect(isSessionIdentifier('UPPER')).toBe(false);
    expect(isSessionIdentifier('')).toBe(false);
    expect(isSessionIdentifier('a'.repeat(200))).toBe(false);
  });
});
