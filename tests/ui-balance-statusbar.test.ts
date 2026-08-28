import { describe, it, expect } from 'vitest';
import { fmtCompact, balanceSegmentLabel, usageSegmentLabel, nextRange } from '../src/wxnodus-ui/lib/balanceStatus.js';

describe('statusbar balance/usage 纯函数', () => {
  it('fmtCompact: 缩写', () => {
    expect(fmtCompact(999)).toBe('999');
    expect(fmtCompact(12345)).toBe('12.3k');
    expect(fmtCompact(1234567)).toBe('123万');
    expect(fmtCompact(-1)).toBe('0');
  });
  it('balanceSegmentLabel: 正常/失败态', () => {
    expect(balanceSegmentLabel({ balance: '110.00', currency: 'CNY', source: 'deepseek' })).toBe('💰 ¥110.00');
    expect(balanceSegmentLabel({ balance: '12.34', currency: 'USD', source: 'openrouter' })).toBe('💰 $12.34');
    expect(balanceSegmentLabel(null)).toBe('💰⚠');
  });
  it('usageSegmentLabel: 区间标注', () => {
    expect(usageSegmentLabel({ total: 600, range: 'today' })).toBe('📊 600 今日');
    expect(usageSegmentLabel({ total: 12345, range: '7d' })).toBe('📊 12.3k 7天');
  });
  it('usageSegmentLabel: 端点未上报用量标记（token 可能被低估——不静默）', () => {
    expect(usageSegmentLabel({ total: 600, range: 'today', unmeasured: 2 })).toBe('📊 600 今日 ⚠2');
    expect(usageSegmentLabel({ total: 600, range: 'today', unmeasured: 0 })).toBe('📊 600 今日');
  });
  it('nextRange: 三档循环', () => {
    expect(nextRange('today')).toBe('7d');
    expect(nextRange('7d')).toBe('30d');
    expect(nextRange('30d')).toBe('today');
  });
});
