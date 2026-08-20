// tests/kernel-cronExpr.test.ts — 标准 cron 5 字段：解析/匹配/every 兼容/描述
import { describe, it, expect } from 'vitest';
import { parseCronExpr, parseIntervalExpr, cronMatches, describeCronExpr } from '../src/kernel/cronExpr.js';

describe('parseCronExpr 解析', () => {
  it('通配/数字/步进/区间/列表', () => {
    expect(parseCronExpr('* * * * *').ok).toBe(true);
    const r = parseCronExpr('*/15 9-17 1,15 * 1-5');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.minute.has(0)).toBe(true);
      expect(r.fields.minute.has(15)).toBe(true);
      expect(r.fields.minute.has(30)).toBe(true);
      expect(r.fields.hour.has(9)).toBe(true);
      expect(r.fields.hour.has(17)).toBe(true);
      expect(r.fields.hour.has(18)).toBe(false);
      expect(r.fields.dayOfMonth.has(1)).toBe(true);
      expect(r.fields.dayOfMonth.has(15)).toBe(true);
      expect(r.fields.dayOfMonth.has(2)).toBe(false);
      expect(r.fields.dayOfWeek.has(1)).toBe(true); // 周一
      expect(r.fields.dayOfWeek.has(5)).toBe(true); // 周五
      expect(r.fields.dayOfWeek.has(6)).toBe(false);
    }
  });
  it('字段越界/非法输入拒绝', () => {
    expect(parseCronExpr('60 * * * *').ok).toBe(false);
    expect(parseCronExpr('* 24 * * *').ok).toBe(false);
    expect(parseCronExpr('* * 32 * *').ok).toBe(false);
    expect(parseCronExpr('* * * 13 *').ok).toBe(false);
    expect(parseCronExpr('* * * * 8').ok).toBe(false);
    expect(parseCronExpr('*/0 * * * *').ok).toBe(false);
    expect(parseCronExpr('abc * * * *').ok).toBe(false);
    expect(parseCronExpr('* * * *').ok).toBe(false); // 4 字段
    expect(parseCronExpr('').ok).toBe(false);
  });
  it('every Nm/Nh/Nd 自然语言兼容', () => {
    const m = parseCronExpr('every 30m');
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.fields.minute.has(0) && m.fields.minute.has(30)).toBe(true);
    const h = parseCronExpr('every 2h');
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.fields.hour.has(0) && h.fields.hour.has(2)).toBe(true);
    const d = parseCronExpr('every 1d');
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.fields.hour.has(0)).toBe(true);
    expect(parseCronExpr('every 0m').ok).toBe(false);
  });
  it('dayOfWeek 7 归一为 0（周日）', () => {
    const r = parseCronExpr('* * * * 7');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.dayOfWeek.has(0)).toBe(true);
      expect(r.fields.dayOfWeek.has(7)).toBe(false);
    }
  });
});

describe('cronMatches 匹配', () => {
  it('命中与未命中', () => {
    const r = parseCronExpr('30 9 * * 1-5');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2026-08-10 是周一 09:30
      expect(cronMatches(r.fields, new Date(2026, 7, 10, 9, 30))).toBe(true);
      expect(cronMatches(r.fields, new Date(2026, 7, 10, 9, 31))).toBe(false);
      expect(cronMatches(r.fields, new Date(2026, 7, 11, 9, 30))).toBe(true); // 周二 09:30，周 1-5 命中
      expect(cronMatches(r.fields, new Date(2026, 7, 16, 9, 30))).toBe(false); // 周日
    }
  });
  it('every 兼容表达式可匹配', () => {
    const r = parseCronExpr('every 15m');
    if (r.ok) {
      expect(cronMatches(r.fields, new Date(2026, 7, 10, 10, 15))).toBe(true);
      expect(cronMatches(r.fields, new Date(2026, 7, 10, 10, 17))).toBe(false);
    }
  });
});

describe('describeCronExpr 描述', () => {
  it('人类可读摘要', () => {
    expect(describeCronExpr('0 9 * * 1-5')).toContain('分:0');
    expect(describeCronExpr('0 9 * * 1-5')).toContain('时:9');
    expect(describeCronExpr('0 9 * * 1-5')).toContain('周:1,2,3,4,5');
    expect(describeCronExpr('*/5 * * * *')).toContain('分:0,5,10,15,20,25,30,35,40,45,50,55');
  });
});

describe('parseIntervalExpr / describeCronExpr（巩固：秒级间隔）', () => {
  it('every Ns 解析为毫秒；N<1 拒绝', () => {
    expect(parseIntervalExpr('every 30s')).toEqual({ intervalMs: 30_000 });
    expect(parseIntervalExpr('every 5m')).toEqual({ intervalMs: 300_000 });
    expect(parseIntervalExpr('every 2h')).toEqual({ intervalMs: 7_200_000 });
    expect(parseIntervalExpr('every 1d')).toEqual({ intervalMs: 86_400_000 });
    expect(parseIntervalExpr('every 0s')).toBeNull();
    expect(parseIntervalExpr('*/5 * * * *')).toBeNull();
  });

  it('describeCronExpr 秒级人类可读', () => {
    expect(describeCronExpr('every 30s')).toBe('每 30 秒');
    expect(describeCronExpr('every 5m')).toBe('每 5 分钟');
  });
});
