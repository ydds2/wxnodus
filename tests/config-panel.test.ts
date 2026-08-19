// tests/config-panel.test.ts — 配置面板纯逻辑契约（行模型/导航/布尔切换）
import { describe, it, expect } from 'vitest';
import { configRows, handleConfigPanelKey, initConfigPanel, toggleBoolean } from '../src/wxnodus-ui/lib/configPanel.js';

describe('configPanel 纯逻辑', () => {
  it('configRows：排序 + 已知标记 + 布尔标记', () => {
    const rows = configRows({ vimMode: true, model: 'deepseek-chat', tui_statusbar: false }, ['vimMode', 'model']);
    expect(rows.map(r => r.key)).toEqual(['model', 'tui_statusbar', 'vimMode']);
    expect(rows.find(r => r.key === 'vimMode')?.known).toBe(true);
    expect(rows.find(r => r.key === 'tui_statusbar')?.known).toBe(false);
    expect(rows.find(r => r.key === 'vimMode')?.boolean).toBe(true);
    expect(rows.find(r => r.key === 'model')?.boolean).toBe(false);
  });

  it('handleConfigPanelKey：↑↓ 夹取 / Enter=edit / Esc=cancel', () => {
    const s = initConfigPanel();
    expect(handleConfigPanelKey(s, { upArrow: true }, 5).next.sel).toBe(0); // 顶部夹取
    expect(handleConfigPanelKey(s, { downArrow: true }, 5).next.sel).toBe(1);
    expect(handleConfigPanelKey(s, {}, 5).action).toBe('none');
    expect(handleConfigPanelKey({ sel: 4 }, { downArrow: true }, 5).next.sel).toBe(4); // 底部夹取
    expect(handleConfigPanelKey(s, { return: true }, 5).action).toBe('edit');
    expect(handleConfigPanelKey(s, { escape: true }, 5).action).toBe('cancel');
  });

  it('toggleBoolean：true→false→true 循环', () => {
    expect(toggleBoolean(true)).toBe(false);
    expect(toggleBoolean(false)).toBe(true);
  });
});
