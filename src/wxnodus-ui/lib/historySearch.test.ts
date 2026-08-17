// src/wxnodus-ui/lib/historySearch.test.ts — Ctrl+R 反向历史搜索（纯函数）
import { describe, expect, it } from 'vitest';
import { searchHistory, searchHistoryWrapped } from './historySearch.js';

const H = ['npm install', '写一个待办系统', 'todo 继续完善', 'git commit -m fix', 'npm test 全绿'];

describe('searchHistory 反向搜索', () => {
  it('向前（更旧方向）查找第一个包含 query 的条目', () => {
    expect(searchHistory(H, 'npm', H.length)).toEqual({ index: 4, text: 'npm test 全绿' });
  });

  it('大小写不敏感子串匹配', () => {
    expect(searchHistory(H, 'TODO', H.length)).toEqual({ index: 2, text: 'todo 继续完善' });
  });

  it('空 query → 最近一条', () => {
    expect(searchHistory(H, '', H.length)).toEqual({ index: 4, text: 'npm test 全绿' });
  });

  it('beforeIndex 限制搜索窗口（Ctrl+R 循环取更旧匹配）', () => {
    const first = searchHistory(H, 'npm', H.length)!;
    expect(first).toEqual({ index: 4, text: 'npm test 全绿' });
    const second = searchHistory(H, 'npm', first.index)!;
    expect(second).toEqual({ index: 0, text: 'npm install' });
    expect(searchHistory(H, 'npm', 0)).toBeNull();
  });

  it('无匹配 / 空历史 → null（不抛错）', () => {
    expect(searchHistory(H, '不存在的词', H.length)).toBeNull();
    expect(searchHistory([], 'x', 0)).toBeNull();
    expect(searchHistory([], '', 5)).toBeNull();
  });
});

describe('searchHistoryWrapped 环绕', () => {
  it('窗口内无匹配 → 从末尾环绕重试', () => {
    // 在 index 0（最旧）之前搜 npm → 窗口内无 → 环绕从末尾找到 index 4
    expect(searchHistoryWrapped(H, 'npm', 0)).toEqual({ index: 4, text: 'npm test 全绿' });
  });

  it('窗口内有匹配 → 不环绕', () => {
    expect(searchHistoryWrapped(H, 'todo', H.length)).toEqual({ index: 2, text: 'todo 继续完善' });
  });
});
