// tests/composer-keys.test.ts — Composer 键位纯函数（提交/换行/历史/光标/编辑）
import { describe, it, expect } from 'vitest';
import { initComposer, handleComposerKey } from '../src/ui/lib/composerKeys.js';

describe('handleComposerKey', () => {
  it('Enter 提交：trim 后提交并清空', () => {
    const s = initComposer();
    const r = handleComposerKey({ ...s, value: '你好' }, { return: true });
    expect(r.action).toEqual({ type: 'submit', text: '你好' });
    expect(r.next.value).toBe('');
    expect(r.next.history[0]).toBe('你好');
  });
  it('空输入 Enter 不提交', () => {
    const r = handleComposerKey(initComposer(), { return: true });
    expect(r.action.type).toBe('none');
  });
  it('Shift+Enter 换行不提交（光标处插入）', () => {
    const s = initComposer();
    const r = handleComposerKey({ ...s, value: '第一行', cursor: 2 }, { return: true, shift: true });
    expect(r.next.value).toBe('第一\n行');
    expect(r.next.cursor).toBe(3);
    expect(r.action.type).toBe('newline');
  });
  it('历史去重 + 上限 1000', () => {
    const s = initComposer();
    let cur = s;
    for (let i = 0; i < 1002; i++) {
      const r = handleComposerKey({ ...cur, value: `msg${i}` }, { return: true });
      cur = r.next;
    }
    expect(cur.history.length).toBeLessThanOrEqual(1000);
    expect(cur.history[0]).toBe('msg1001');
  });
  it('↑↓ 历史导航', () => {
    const s = initComposer();
    const r1 = handleComposerKey({ ...s, value: 'a' }, { return: true });
    const r2 = handleComposerKey({ ...r1.next, value: 'b' }, { return: true });
    const up = handleComposerKey({ ...r2.next }, { upArrow: true });
    expect(up.next.value).toBe('b'); // 最新一条
    const up2 = handleComposerKey(up.next, { upArrow: true });
    expect(up2.next.value).toBe('a');
    const down = handleComposerKey(up2.next, { downArrow: true });
    expect(down.next.value).toBe('b');
  });
  it('字符输入：插入光标处', () => {
    const r = handleComposerKey({ value: 'ac', cursor: 1, history: [], hIndex: -1 }, { input: 'b' });
    expect(r.next.value).toBe('abc');
    expect(r.next.cursor).toBe(2);
  });
  it('粘贴多字符整体插入（ink 一次性回调）', () => {
    const r = handleComposerKey({ value: 'a', cursor: 1, history: [], hIndex: -1 }, { input: 'hello 世界' });
    expect(r.next.value).toBe('ahello 世界');
    expect(r.next.cursor).toBe(9); // 1 + 'hello 世界'.length(8)
  });
  it('控制组合键（Ctrl+C 等）不输入', () => {
    const r = handleComposerKey({ value: 'a', cursor: 1, history: [], hIndex: -1 }, { input: 'c', ctrl: true });
    expect(r.next.value).toBe('a');
    expect(r.action.type).toBe('none');
  });
  it('Backspace 删除光标前字符', () => {
    const r = handleComposerKey({ value: 'abc', cursor: 2, history: [], hIndex: -1 }, { backspace: true });
    expect(r.next.value).toBe('ac');
    expect(r.next.cursor).toBe(1);
  });
  it('Backspace 在行首不删除', () => {
    const r = handleComposerKey({ value: 'abc', cursor: 0, history: [], hIndex: -1 }, { backspace: true });
    expect(r.next.value).toBe('abc');
    expect(r.action.type).toBe('none');
  });
  it('Delete 删除光标处字符', () => {
    const r = handleComposerKey({ value: 'abc', cursor: 1, history: [], hIndex: -1 }, { delete: true });
    expect(r.next.value).toBe('ac');
    expect(r.next.cursor).toBe(1);
  });
  it('←→ 光标移动（边界钳制）', () => {
    const s = { value: 'ab', cursor: 1, history: [], hIndex: -1 };
    expect(handleComposerKey(s, { leftArrow: true }).next.cursor).toBe(0);
    expect(handleComposerKey({ ...s, cursor: 0 }, { leftArrow: true }).next.cursor).toBe(0);
    expect(handleComposerKey(s, { rightArrow: true }).next.cursor).toBe(2);
    expect(handleComposerKey({ ...s, cursor: 2 }, { rightArrow: true }).next.cursor).toBe(2);
  });
  it('Home/End 跳行首/行尾', () => {
    const s = { value: 'abc', cursor: 2, history: [], hIndex: -1, suggestSel: 0 };
    expect(handleComposerKey(s, { home: true }).next.cursor).toBe(0);
    expect(handleComposerKey(s, { end: true }).next.cursor).toBe(3);
  });
  it('建议态 Enter 执行选中命令', () => {
    const s = { value: '/he', cursor: 3, history: [], hIndex: -1, suggestSel: 0 };
    const r = handleComposerKey(s, { return: true }, ['/help', '/hole']);
    expect(r.action).toEqual({ type: 'submit', text: '/help' });
    expect(r.next.value).toBe('');
  });
  it('建议态 ↑↓ 移动选择（替代历史导航）', () => {
    const s = { value: '/he', cursor: 3, history: [], hIndex: -1, suggestSel: 0 };
    const down = handleComposerKey(s, { downArrow: true }, ['/help', '/hole']);
    expect(down.next.suggestSel).toBe(1);
    const up = handleComposerKey(down.next, { upArrow: true }, ['/help', '/hole']);
    expect(up.next.suggestSel).toBe(0);
  });
  it('Tab 补全选中命令', () => {
    const s = { value: '/h', cursor: 2, history: [], hIndex: -1, suggestSel: 1 };
    const r = handleComposerKey(s, { tab: true }, ['/help', '/hole']);
    expect(r.next.value).toBe('/hole');
    expect(r.next.cursor).toBe(5);
    expect(r.action.type).toBe('setValue');
  });
  it('Esc 清空输入取消建议', () => {
    const s = { value: '/he', cursor: 3, history: [], hIndex: -1, suggestSel: 0 };
    const r = handleComposerKey(s, { escape: true }, ['/help']);
    expect(r.next.value).toBe('');
    expect(r.next.cursor).toBe(0);
  });
  it('无建议时 Enter 正常提交普通文本', () => {
    const s = { value: '做个待办', cursor: 4, history: [], hIndex: -1, suggestSel: 0 };
    const r = handleComposerKey(s, { return: true }, []);
    expect(r.action).toEqual({ type: 'submit', text: '做个待办' });
  });
  it('建议态 Backspace 删除后返回普通输入', () => {
    const s = { value: '/h', cursor: 2, history: [], hIndex: -1, suggestSel: 0 };
    const r = handleComposerKey(s, { backspace: true }, ['/help']);
    expect(r.next.value).toBe('/');
    const r2 = handleComposerKey(r.next, { backspace: true }, []);
    expect(r2.next.value).toBe('');
  });
});
