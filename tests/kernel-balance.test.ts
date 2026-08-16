import { describe, it, expect } from 'vitest';
import { getByPath } from '../src/kernel/jsonPath.js';
import { parseBalanceForHost } from '../src/kernel/balance.js';

describe('jsonPath', () => {
  it('嵌套对象与数组索引', () => {
    expect(getByPath({ a: { b: [{ c: 42 }] } }, 'a.b[0].c')).toBe(42);
  });
  it('缺失路径返回 undefined 不抛', () => {
    expect(getByPath({ a: 1 }, 'x.y.z')).toBeUndefined();
  });
  it('顶层数组', () => {
    expect(getByPath([{ v: 'x' }], '[0].v')).toBe('x');
  });
});

describe('balance adapters', () => {
  it('deepseek: balance_infos[].total_balance + currency（CNY 优先）', () => {
    const r = parseBalanceForHost('api.deepseek.com', {
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' },
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    });
    expect(r?.balance).toBe('110.00');
    expect(r?.currency).toBe('CNY');
    expect(r?.source).toBe('deepseek');
  });

  it('kimi: data.available_balance（形状 (R)）', () => {
    const r = parseBalanceForHost('api.moonshot.cn', { code: 0, data: { available_balance: 66.5, voucher_balance: 10, cash_balance: 56.5 } });
    expect(r?.balance).toBe('66.5');
    expect(r?.source).toBe('kimi');
  });

  it('siliconflow: data.balance 优先', () => {
    const r = parseBalanceForHost('api.siliconflow.cn', { code: 20000, data: { balance: '3.21', chargeBalance: '3.21', totalBalance: '3.21' } });
    expect(r?.balance).toBe('3.21');
    expect(r?.source).toBe('siliconflow');
  });

  it('openrouter: data.total_credits', () => {
    const r = parseBalanceForHost('openrouter.ai', { data: { total_credits: 12.34, total_usage: 0 } });
    expect(r?.balance).toBe('12.34');
    expect(r?.source).toBe('openrouter');
  });

  it('generic 启发式：balance 键命中', () => {
    const r = parseBalanceForHost('relay.example.com', { data: { balance: '9.99' } });
    expect(r?.balance).toBe('9.99');
    expect(r?.source).toBe('generic');
  });

  it('未命中且无 jsonPath → null（诚实不伪造）', () => {
    expect(parseBalanceForHost('relay.example.com', { hello: 'world' })).toBeNull();
  });

  it('jsonPath 兜底：优先于启发式', () => {
    const r = parseBalanceForHost('relay.example.com', { meta: { money: { left: 7.5 } } }, 'meta.money.left');
    expect(r?.balance).toBe('7.5');
    expect(r?.source).toBe('path');
  });
});
