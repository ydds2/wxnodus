// tests/lines.test.ts — 行数估算 / 消息滚动裁剪（纯函数）
import { describe, it, expect } from 'vitest';
import { estimateLines, strWidth, trimTail } from '../src/ui/lib/lines.js';

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
