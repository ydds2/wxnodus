// src/wxnodus-ui/lib/permCycle.test.ts — Shift+Tab 模式循环（纯函数）
import { describe, expect, it } from 'vitest';
import { PERM_MODES, nextPermMode } from './permCycle.js';

describe('nextPermMode 模式循环', () => {
  it('全序循环：smart→auto→manual→plan→yolo→goal→smart', () => {
    const seq = ['smart', 'auto', 'manual', 'plan', 'yolo', 'goal', 'smart'];
    for (let i = 0; i < seq.length - 1; i++) {
      expect(nextPermMode(seq[i])).toBe(seq[i + 1]);
    }
  });

  it('未知/空值回退 smart（不假装高权限）', () => {
    expect(nextPermMode('')).toBe('smart');
    expect(nextPermMode(undefined)).toBe('smart');
    expect(nextPermMode(null)).toBe('smart');
    expect(nextPermMode('garbage')).toBe('smart');
  });

  it('PERM_MODES 与 kernel 六模式一致（smart/auto/manual/plan/yolo/goal）', () => {
    expect([...PERM_MODES].sort()).toEqual(['auto', 'goal', 'manual', 'plan', 'smart', 'yolo']);
  });
});
