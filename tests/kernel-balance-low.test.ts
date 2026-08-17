// tests/kernel-balance-low.test.ts — 低余额预警（余额耗尽场景护栏）
import { describe, it, expect } from 'vitest';
import { numericBalance, lowBalanceDecision, LOW_BALANCE_THRESHOLD } from '../src/kernel/balance.js';

describe('numericBalance 宽容解析', () => {
  it('常见形态：纯数字/货币前缀/千分位/空白', () => {
    expect(numericBalance({ balance: '110.00' })).toBe(110);
    expect(numericBalance({ balance: '¥110.00' })).toBe(110);
    expect(numericBalance({ balance: '$12.34' })).toBe(12.34);
    expect(numericBalance({ balance: '1,234.5' })).toBe(1234.5);
    expect(numericBalance({ balance: '  42  ' })).toBe(42);
  });
  it('非数字形态 → null（诚实：不编数字）', () => {
    expect(numericBalance({ balance: '充足' })).toBeNull();
    expect(numericBalance({ balance: '' })).toBeNull();
    expect(numericBalance(null)).toBeNull();
    expect(numericBalance(undefined)).toBeNull();
  });
  it('默认阈值 5', () => {
    expect(LOW_BALANCE_THRESHOLD).toBe(5);
  });
});

describe('lowBalanceDecision 状态机', () => {
  it('首次低于阈值 → notify + armed', () => {
    expect(lowBalanceDecision(3, 5, false)).toEqual({ notify: true, armed: true });
  });
  it('已通知后仍低 → 不重复通知（防刷屏）', () => {
    expect(lowBalanceDecision(3, 5, true)).toEqual({ notify: false, armed: true });
  });
  it('回升到阈值以上 → 重新武装（下次再低会再提醒）', () => {
    expect(lowBalanceDecision(10, 5, true)).toEqual({ notify: false, armed: false });
  });
  it('数值不可解析 → 保持原武装态，不误报', () => {
    expect(lowBalanceDecision(null, 5, false)).toEqual({ notify: false, armed: false });
    expect(lowBalanceDecision(null, 5, true)).toEqual({ notify: false, armed: true });
  });
});
