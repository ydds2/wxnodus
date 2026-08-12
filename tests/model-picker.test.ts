// tests/model-picker.test.ts — 模型选择器纯函数（键位/过滤/分组）
import { describe, it, expect } from 'vitest';
import { filterModels, MODEL_CATALOG } from '../src/kernel/providers.js';
import { initPicker, handlePickerKey, groupByProvider } from '../src/wxnodus-ui/lib/modelPicker.js';

describe('filterModels 模型过滤', () => {
  it('空查询返回全部', () => {
    expect(filterModels('').length).toBe(MODEL_CATALOG.length);
  });
  it('名称子串（不区分大小写）', () => {
    expect(filterModels('flash').map(m => m.name)).toContain('DeepSeek V4 Flash');
    expect(filterModels('k2').map(m => m.name)).toEqual(['K2.7 Coding', 'K2.7 Coding Highspeed']);
  });
  it('提供商子串', () => {
    expect(filterModels('kimi').every(m => m.provider === 'kimi')).toBe(true);
    expect(filterModels('glm').every(m => m.provider === 'zhipu')).toBe(true);
  });
});

describe('groupByProvider 分组', () => {
  it('按提供商聚合且保持目录顺序', () => {
    const g = groupByProvider(MODEL_CATALOG);
    expect(g.map(x => x.provider)).toEqual(['deepseek', 'kimi', 'zhipu', 'offline']);
    expect(g[0]!.models.length).toBe(4);
  });
});

describe('handlePickerKey 键位', () => {
  it('Enter → pick / Esc → cancel', () => {
    expect(handlePickerKey(initPicker(), { return: true }, 5).action.type).toBe('pick');
    expect(handlePickerKey(initPicker(), { escape: true }, 5).action.type).toBe('cancel');
  });
  it('←→ → toggleThinking', () => {
    expect(handlePickerKey(initPicker(), { leftArrow: true }, 5).action.type).toBe('toggleThinking');
    expect(handlePickerKey(initPicker(), { rightArrow: true }, 5).action.type).toBe('toggleThinking');
  });
  it('↑↓ 导航（边界钳制）', () => {
    const s = initPicker();
    expect(handlePickerKey(s, { downArrow: true }, 5).next.sel).toBe(1);
    expect(handlePickerKey({ ...s, sel: 4 }, { downArrow: true }, 5).next.sel).toBe(4);
    expect(handlePickerKey({ ...s, sel: 0 }, { upArrow: true }, 5).next.sel).toBe(0);
  });
  it('字符输入过滤 + Backspace 删除', () => {
    const r1 = handlePickerKey(initPicker(), { inputChar: 'k' }, 10);
    expect(r1.next.q).toBe('k');
    expect(r1.next.sel).toBe(0);
    const r2 = handlePickerKey(r1.next, { backspace: true }, 10);
    expect(r2.next.q).toBe('');
  });
  it('Ctrl 组合键不进入搜索', () => {
    const r = handlePickerKey(initPicker(), { inputChar: 'g', ctrl: true }, 5);
    expect(r.next.q).toBe('');
  });
});
