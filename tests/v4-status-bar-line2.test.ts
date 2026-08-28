// V4 UI 闭环（kimi 行2）：context% 数学 + 兜底段契约
// 2026-08-22 用户真机反馈「行2 恒空 / UI 未更新」根因回归锁：
//   ① context_percent 曾按 pct/100 再 toFixed(1)（9% 显示成 0.1%）——锁整数直显
//   ② context 数据未到时行2 静默 return null——锁 session token 兜底段（行2 恒有内容）
import { describe, it, expect } from 'vitest';
import { buildStatusRows } from '../src/wxnodus-ui/components/statusBarSegments.js';

const base = { state: 'ready' as const, statusText: '' };

describe('kimi 行2（buildStatusRows.line2）', () => {
  it('context 段：整数百分比直显（9 → context: 9%，不再除 100）', () => {
    const rows = buildStatusRows({
      ...base,
      usage: { context_percent: 9, context_used: 5_800, context_max: 64_000 },
    });
    const text = rows.line2.segments.map(s => s.text).join(' ');
    expect(text).toContain('context: 9%');
    expect(text).toContain('(5.8k/64.0k)');
  });

  it('水位着色：≥85 error / ≥75 warn / 常规 muted', () => {
    const seg = (pct: number) =>
      buildStatusRows({ ...base, usage: { context_percent: pct, context_max: 64_000 } })
        .line2.segments.find(s => s.id === 'cost');
    expect(seg(90)?.color).toBe('error');
    expect(seg(80)?.color).toBe('warn');
    expect(seg(20)?.color).toBe('muted');
  });

  it('兜底段：context/cost 均缺但有会话累计 → session: N tok（行2 不静默消失）', () => {
    const rows = buildStatusRows({
      ...base,
      usage: { calls: 3, input: 9_000, output: 3_000, total: 12_000 },
    });
    const text = rows.line2.segments.map(s => s.text).join(' ');
    expect(text).toContain('session: 12.0k tok');
  });

  it('无任何 usage 数据 → line2 空（首回合前不占行）', () => {
    const rows = buildStatusRows(base);
    expect(rows.line2.segments).toHaveLength(0);
  });
});
