// tests/composer-keys.test.ts — L6-2 Composer 键位纯函数（Enter 提交/换行/历史）
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
  it('Shift+Enter 换行不提交', () => {
    const s = initComposer();
    const r = handleComposerKey({ ...s, value: '第一行' }, { return: true, shift: true });
    expect(r.next.value).toBe('第一行\n');
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
});
