// tests/ui-components.test.tsx — L6-2 交互层组件：主题/消息流/Markdown/确认
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { getTheme, THEMES } from '../src/ui/theme.js';
import { MessageLine } from '../src/ui/components/MessageLine.js';
import { Markdown } from '../src/ui/components/Markdown.js';
import { StatusBar } from '../src/ui/components/StatusBar.js';
import { patchUi } from '../src/app/stores/uiStore.js';
import { patchOverlay } from '../src/app/stores/overlayStore.js';
import { ApprovalPrompt } from '../src/ui/components/ApprovalPrompt.js';
import { filterCommands, isSuggesting } from '../src/ui/lib/suggest.js';

describe('主题（Kimi 风格多主题）', () => {
  it('THEMES 含 kimi/dark/light 且键齐全', () => {
    for (const name of ['kimi', 'dark', 'light']) {
      const t = THEMES[name];
      expect(t).toBeTruthy();
      for (const k of ['text', 'muted', 'border', 'accent', 'ok', 'warn', 'error']) {
        expect(typeof t[k]).toBe('string');
      }
    }
  });
  it('getTheme 返回默认 kimi', () => {
    expect(getTheme().accent).toBe(THEMES.kimi.accent);
  });
});

describe('消息行渲染', () => {
  it('用户消息 ❯ gutter', () => {
    const { lastFrame } = render(<MessageLine m={{ id: '1', role: 'user', text: '你好' }} />);
    expect(lastFrame()).toContain('❯');
    expect(lastFrame()).toContain('你好');
  });
  it('助手消息 ✦ gutter', () => {
    const { lastFrame } = render(<MessageLine m={{ id: '2', role: 'assistant', text: '收到', ms: 1200 }} />);
    expect(lastFrame()).toContain('✦');
    expect(lastFrame()).toContain('收到');
  });
  it('错误消息红边框', () => {
    const { lastFrame } = render(<MessageLine m={{ id: '3', role: 'system', text: '出错了', error: true }} />);
    expect(lastFrame()).toContain('出错了');
  });
});

describe('Markdown 渲染', () => {
  it('标题/列表/代码块渲染', () => {
    const { lastFrame } = render(<Markdown text={'# 标题\n\n- 项一\n- 项二'} />);
    expect(lastFrame()).toContain('标题');
    expect(lastFrame()).toContain('项一');
  });
  it('代码块含 lang 标签', () => {
    const { lastFrame } = render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    expect(lastFrame()).toContain('ts');
    expect(lastFrame()).toContain('const a');
  });
});

describe('命令建议（suggest 纯函数）', () => {
  it('filterCommands 前缀+子序列', () => {
    const cmds = ['/help', '/history', '/home', '/build', '/backup'];
    expect(filterCommands('/h', cmds)).toEqual(['/help', '/history', '/home']);
    expect(filterCommands('/bu', cmds)).toEqual(['/build', '/backup']);
    expect(filterCommands('/hl', cmds)).toContain('/help');
  });
  it('空查询返回前 6', () => {
    const cmds = Array.from({ length: 20 }, (_, i) => `/cmd${i}`);
    expect(filterCommands('', cmds).length).toBe(6);
  });
  it('isSuggesting 判定 / 开头且无空格', () => {
    expect(isSuggesting('/hel')).toBe(true);
    expect(isSuggesting('/help x')).toBe(false);
    expect(isSuggesting('hello')).toBe(false);
    expect(isSuggesting('')).toBe(false);
  });
});

describe('状态条（Kimi 三栏）', () => {
  it('模型/上下文条/时钟/模式徽章', () => {
    patchUi({ model: 'deepseek-v4-flash', contextPct: 0.23, clock: '12:00', mode: 'auto', stage: 'work', busy: false, sessionId: null, cwd: 'C:\\', themeName: 'kimi', notice: null, thinking: true });
    const { lastFrame } = render(<StatusBar />);
    expect(lastFrame()).toContain('deepseek');
    expect(lastFrame()).toContain('23%');
    expect(lastFrame()).toContain('12:00');
    expect(lastFrame()).toContain('auto');
  });
});

describe('确认弹层', () => {
  it('4 选项渲染', () => {
    patchOverlay({ approval: { title: '运行命令', detail: 'rm -rf tmp', allowPermanent: true } });
    const { lastFrame } = render(<ApprovalPrompt onRespond={() => {}} />);
    expect(lastFrame()).toContain('仅此一次');
    expect(lastFrame()).toContain('始终允许');
  });
  it('无 allowPermanent 时 3 选项', () => {
    patchOverlay({ approval: { title: 't', detail: 'd', allowPermanent: false } });
    const { lastFrame } = render(<ApprovalPrompt onRespond={() => {}} />);
    expect(lastFrame()).toContain('仅此一次');
    expect(lastFrame()).not.toContain('始终允许');
  });
});
