// tests/computer.test.ts — L3-3b computer use 底座：动作层/坐标换算/安全护栏
import { describe, it, expect } from 'vitest';
import { validateAction, inBounds, convertCoords, type CuAction } from '../src/kernel/computer/actionLayer.js';
import { ActionGuard } from '../src/kernel/computer/guards.js';

describe('动作层 schema', () => {
  it('合法动作通过校验', () => {
    expect(validateAction({ type: 'click', x: 100, y: 200 })).toBe(true);
    expect(validateAction({ type: 'type', text: '你好' })).toBe(true);
    expect(validateAction({ type: 'key', key: 'enter' })).toBe(true);
    expect(validateAction({ type: 'paste', text: 'x' })).toBe(true);
    expect(validateAction({ type: 'scroll', x: 1, y: 1, amount: 3 })).toBe(true);
    expect(validateAction({ type: 'open', url: 'https://x.com' })).toBe(true);
  });
  it('非法动作拒绝', () => {
    expect(validateAction({ type: 'explode' } as any)).toBe(false);
    expect(validateAction({ type: 'click' } as any)).toBe(false); // 缺坐标
    expect(validateAction({ type: 'type' } as any)).toBe(false); // 缺文本
  });
});

describe('坐标换算（DPI 缩放）', () => {
  it('物理像素 → 逻辑像素', () => {
    // 截图 1920 物理宽，scale 1.25 → 逻辑 1536
    expect(convertCoords(100, 100, { scale: 1.25 })).toEqual({ x: 80, y: 80 });
  });
  it('scale=1 不变', () => {
    expect(convertCoords(500, 300, { scale: 1 })).toEqual({ x: 500, y: 300 });
  });
});

describe('inBounds 边界校验', () => {
  it('范围内放行，越界拒绝', () => {
    expect(inBounds(100, 200, { width: 1920, height: 1080 })).toBe(true);
    expect(inBounds(2000, 100, { width: 1920, height: 1080 })).toBe(false);
    expect(inBounds(-5, 10, { width: 100, height: 100 })).toBe(false);
  });
});

describe('ActionGuard 安全护栏', () => {
  it('abort 后所有动作被拒', () => {
    const g = new ActionGuard({ width: 1920, height: 1080 });
    g.abort();
    expect(() => g.check({ type: 'click', x: 10, y: 10 })).toThrow(/中止/);
  });
  it('越界点击被拒', () => {
    const g = new ActionGuard({ width: 1920, height: 1080 });
    expect(() => g.check({ type: 'click', x: 9999, y: 10 })).toThrow(/越界/);
  });
  it('合法动作放行', () => {
    const g = new ActionGuard({ width: 1920, height: 1080 });
    expect(() => g.check({ type: 'click', x: 500, y: 500 })).not.toThrow();
  });
});

describe('动作序列（可视化 AI 技能管线）', () => {
  it('动作计划校验：全部合法才通过', () => {
    const plan: CuAction[] = [
      { type: 'open', url: 'https://example.com' },
      { type: 'click', x: 100, y: 100 },
      { type: 'type', text: 'hello' },
    ];
    expect(plan.every(validateAction)).toBe(true);
  });
});
