// tests/keymap.test.ts — supremacy 3.3 键位配置层（B-01）：解析/匹配/覆盖合并/默认零漂移/活动键位单例
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseKeySpec, matchesKey, matchesAny, resolveKeymap, DEFAULT_KEYMAP, getActiveKeymap, setActiveKeymap,
} from '../src/wxnodus-ui/config/keymap.js';

afterEach(() => { setActiveKeymap(resolveKeymap(undefined)); });

describe('parseKeySpec（键位规范解析）', () => {
  it('命名键/修饰组合/单字符（大小写敏感）', () => {
    expect(parseKeySpec('enter')).toEqual({ key: 'enter' });
    expect(parseKeySpec('shift+enter')).toEqual({ key: 'enter', shift: true });
    expect(parseKeySpec('ctrl+j')).toEqual({ key: 'j', ctrl: true });
    expect(parseKeySpec('ctrl+shift+meta+k')).toEqual({ key: 'k', ctrl: true, shift: true, meta: true });
    expect(parseKeySpec('G')).toEqual({ key: 'G' });
    expect(parseKeySpec('g')).toEqual({ key: 'g' });
    expect(parseKeySpec('space')).toEqual({ key: ' ' });
    expect(parseKeySpec('pageup')).toEqual({ key: 'pageup' });
  });
  it('非法规范 → null（多字符/未知修饰/超长/空）', () => {
    expect(parseKeySpec('')).toBeNull();
    expect(parseKeySpec('ctrl+abc')).toBeNull();
    expect(parseKeySpec('alt+x')).toBeNull();
    expect(parseKeySpec('x'.repeat(50))).toBeNull();
    expect(parseKeySpec('   ')).toBeNull();
  });
});

describe('matchesKey / matchesAny（事件命中）', () => {
  const ev = (o: Record<string, unknown>) => o;
  it('单字符匹配要求修饰一致（ctrl+c 与裸 c 不同）', () => {
    expect(matchesKey(ev({ ctrl: true }), 'c', { key: 'c', ctrl: true })).toBe(true);
    expect(matchesKey(ev({}), 'c', { key: 'c', ctrl: true })).toBe(false);
    expect(matchesKey(ev({}), 'c', { key: 'c' })).toBe(true);
  });
  it('命名键匹配（enter/escape/up/down/pageup/pagedown）', () => {
    expect(matchesKey(ev({ return: true }), '', { key: 'enter' })).toBe(true);
    expect(matchesKey(ev({ escape: true }), '', { key: 'escape' })).toBe(true);
    expect(matchesKey(ev({ upArrow: true }), 'k', { key: 'up' })).toBe(true);
    expect(matchesKey(ev({ pageDown: true }), ' ', { key: 'pagedown' })).toBe(true);
    expect(matchesKey(ev({}), 'q', { key: 'escape' })).toBe(false);
  });
  it('matchesAny：任一命中即真', () => {
    expect(matchesAny(ev({ escape: true }), 'q', DEFAULT_KEYMAP.pagerClose)).toBe(true);
    expect(matchesAny(ev({ ctrl: true }), 'c', DEFAULT_KEYMAP.pagerClose)).toBe(true);
    expect(matchesAny(ev({}), 'q', DEFAULT_KEYMAP.pagerClose)).toBe(true);
    expect(matchesAny(ev({}), 'x', DEFAULT_KEYMAP.pagerClose)).toBe(false);
  });
});

describe('resolveKeymap（settings 覆盖合并）', () => {
  it('默认行为=既有硬编码（零漂移契约）', () => {
    const km = resolveKeymap(undefined);
    expect(km.pagerClose).toEqual(DEFAULT_KEYMAP.pagerClose);
    expect(km.pagerUp).toEqual(DEFAULT_KEYMAP.pagerUp);
  });
  it('覆盖生效：pagerClose 改 ctrl+x → escape 不再命中', () => {
    const km = resolveKeymap({ pagerClose: 'ctrl+x' });
    expect(km.pagerClose).toEqual([{ key: 'x', ctrl: true }]);
    expect(matchesAny({ ctrl: true }, 'x', km.pagerClose)).toBe(true);
    expect(matchesAny({ escape: true }, '', km.pagerClose)).toBe(false);
  });
  it('多键数组 + 部分非法：合法保留、非法丢弃、全非法回退默认', () => {
    const km = resolveKeymap({ pagerUp: ['ctrl+k', 'bogus+key', 42], pagerTop: ['nonsense!!'] });
    expect(km.pagerUp).toEqual([{ key: 'k', ctrl: true }]);
    expect(km.pagerTop).toEqual(DEFAULT_KEYMAP.pagerTop); // 全非法 → 默认
  });
  it('未知动作名忽略；非对象整体忽略', () => {
    const km = resolveKeymap({ unknownAction: 'ctrl+x', pagerDown: 'ctrl+j' });
    expect(km.pagerDown).toEqual([{ key: 'j', ctrl: true }]);
    expect(resolveKeymap('not-an-object').pagerDown).toEqual(DEFAULT_KEYMAP.pagerDown);
  });
});

describe('活动键位单例（setActiveKeymap/getActiveKeymap）', () => {
  it('默认读取 DEFAULT；set 后生效（TUI 水合通道）', () => {
    expect(getActiveKeymap().pagerClose).toEqual(DEFAULT_KEYMAP.pagerClose);
    setActiveKeymap(resolveKeymap({ pagerClose: 'ctrl+x' }));
    expect(getActiveKeymap().pagerClose).toEqual([{ key: 'x', ctrl: true }]);
  });
});
