// tests/lines.test.ts — 行数估算 / 消息滚动裁剪（纯函数）
import { describe, it, expect } from 'vitest';
import { estimateLines, strWidth, trimTail, scrollTail } from '../src/wxnodus-ui/lib/lines.js';

describe('strWidth / estimateLines', () => {
  it('ASCII 1 列 / 中文 2 列', () => {
    expect(strWidth('hello')).toBe(5);
    expect(strWidth('你好')).toBe(4);
    expect(strWidth('a你b')).toBe(4);
  });
  it('单行估算：短文本 1 行，超宽向上取整', () => {
    expect(estimateLines('短', 10)).toBe(1);
    expect(estimateLines('a'.repeat(25), 10)).toBe(3);
  });
  it('多行：\n 分段累加', () => {
    expect(estimateLines('ab\ncd', 10)).toBe(2);
    expect(estimateLines('a'.repeat(12) + '\n' + 'b'.repeat(12), 10)).toBe(4);
  });
  it('空文本 0 行', () => {
    expect(estimateLines('', 10)).toBe(0);
  });
});

describe('trimTail 尾部裁剪', () => {
  const mk = (id: string, text: string): { id: string; text: string } => ({ id, text });
  it('能放下的全保留', () => {
    const items = [mk('1', 'a'), mk('2', 'b')];
    const r = trimTail(items, 10, 80);
    expect(r.items.map(i => i.id)).toEqual(['1', '2']);
    expect(r.overflow).toBe(0);
  });
  it('超出行数只保留尾部', () => {
    const items = [mk('1', 'a'), mk('2', 'b'), mk('3', 'c'), mk('4', 'd')];
    const r = trimTail(items, 2, 80); // 4 条 × 1 行，只留 2
    expect(r.items.map(i => i.id)).toEqual(['3', '4']);
    expect(r.overflow).toBe(2);
  });
  it('单条超高时至少显示该条', () => {
    const items = [mk('1', 'a'), mk('2', 'b'.repeat(300))];
    const r = trimTail(items, 2, 10);
    expect(r.items.map(i => i.id)).toEqual(['2']);
  });
  it('预留流式行数（extraLines）', () => {
    const items = [mk('1', 'a'), mk('2', 'b'), mk('3', 'c')];
    const r = trimTail(items, 3, 80, 2); // 3 行预算，流式占 2 → 历史只留 1
    expect(r.items.map(i => i.id)).toEqual(['3']);
  });
  it('面积不足返回空', () => {
    const r = trimTail([mk('1', 'a')], 0, 80);
    expect(r.items).toEqual([]);
  });
});

describe('scrollTail 应用内滚动', () => {
  const mk = (id: string, text: string): { id: string; text: string } => ({ id, text });
  const four = [mk('1', 'a'), mk('2', 'b'), mk('3', 'c'), mk('4', 'd')]; // 各 1 行

  it('offset=0 显示尾部（与 trimTail 一致）', () => {
    const r = scrollTail(four, 0, 2, 80);
    expect(r.visible.map(i => i.id)).toEqual(['3', '4']);
    expect(r.atBottom).toBe(true);
    expect(r.overflow).toBe(2);
  });
  it('上滑后可见更早消息', () => {
    const r = scrollTail(four, 2, 2, 80); // 上滑 2 行 → 看到全部
    expect(r.visible.map(i => i.id)).toEqual(['1', '2', '3', '4']);
    expect(r.atBottom).toBe(false);
  });
  it('offset 钳制到 maxOffset', () => {
    const r = scrollTail(four, 99, 2, 80);
    expect(r.maxOffset).toBe(2);
    expect(r.visible.map(i => i.id)).toEqual(['1', '2', '3', '4']);
  });
  it('单条超高至少显示该条', () => {
    const r = scrollTail([mk('1', 'a'), mk('2', 'b'.repeat(300))], 0, 2, 10);
    expect(r.visible.map(i => i.id)).toEqual(['2']);
  });
  it('extraLines（流式区）计入总行数', () => {
    const r = scrollTail(four, 0, 2, 80, 1); // 流式占 1 行 → 历史留 1 行
    expect(r.visible.map(i => i.id)).toEqual(['4']);
    expect(r.totalLines).toBe(5);
  });
  it('空列表', () => {
    const r = scrollTail([], 0, 10, 80);
    expect(r.visible).toEqual([]);
    expect(r.totalLines).toBe(0);
    expect(r.atBottom).toBe(true);
  });
});
