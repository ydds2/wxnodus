// tests/ui-components.test.tsx — L6-2 交互层组件（V3 自研组件接口）：主题/消息行/Markdown/状态条/审批
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { DARK_THEME, LIGHT_THEME, DEFAULT_THEME } from '../src/wxnodus-ui/theme.js';
import { MessageLine } from '../src/wxnodus-ui/components/messageLine.js';
import { Md } from '../src/wxnodus-ui/components/markdown.js';
import { CommandPalette } from '../src/wxnodus-ui/components/commandPalette.js';
import { statusBarSegments } from '../src/wxnodus-ui/components/appChrome.js';
import { ApprovalPrompt } from '../src/wxnodus-ui/components/prompts.js';
import { filterCommands, isSuggesting } from '../src/wxnodus-ui/lib/suggest.js';

describe('主题（自研明暗双主题）', () => {
  it('DARK/LIGHT 主题颜色键齐全', () => {
    for (const t of [DARK_THEME, LIGHT_THEME]) {
      for (const k of ['text', 'muted', 'border', 'accent', 'ok', 'warn', 'error', 'userBg']) {
        expect(typeof t.color[k]).toBe('string');
      }
    }
  });
  it('DEFAULT_THEME 为明暗之一', () => {
    expect([DARK_THEME, LIGHT_THEME]).toContain(DEFAULT_THEME);
  });
});

describe('消息行渲染（V3 MessageLine）', () => {
  const t = DEFAULT_THEME;
  it('用户消息可见', () => {
    const { lastFrame } = render(<MessageLine cols={80} msg={{ id: '1', role: 'user', text: '你好' }} t={t} />);
    expect(lastFrame()).toContain('你好');
  });
  it('助手消息可见', () => {
    const { lastFrame } = render(<MessageLine cols={80} msg={{ id: '2', role: 'assistant', text: '收到' }} t={t} />);
    expect(lastFrame()).toContain('收到');
  });
  it('错误消息可见', () => {
    const { lastFrame } = render(<MessageLine cols={80} msg={{ id: '3', role: 'system', text: '出错了' }} t={t} />);
    expect(lastFrame()).toContain('出错了');
  });
});

describe('消息轮次边界（V3 分隔线）', () => {
  const t = DEFAULT_THEME;
  it('回复直接跟在用户提问后显示 └─ Response 分隔', () => {
    const { lastFrame } = render(
      <MessageLine cols={80} msg={{ role: 'assistant', text: '收到' }} t={t} prev={{ role: 'user', text: '你好' }} />
    );
    expect(lastFrame()).toContain('Response');
  });
  it('首条助手消息（无前驱）不显示分隔', () => {
    const { lastFrame } = render(<MessageLine cols={80} msg={{ role: 'assistant', text: '收到' }} t={t} />);
    expect(lastFrame()).not.toContain('Response');
  });
  it('助手消息跟在助手消息后不重复分隔（段内不打断）', () => {
    const { lastFrame } = render(
      <MessageLine cols={80} msg={{ role: 'assistant', text: '收到' }} t={t} prev={{ role: 'assistant', text: '上一段' }} />
    );
    expect(lastFrame()).not.toContain('Response');
  });
});

describe('Markdown 渲染（V3 Md）', () => {
  const t = DEFAULT_THEME;
  it('标题/列表渲染', () => {
    const { lastFrame } = render(<Md text={'# 标题\n\n- 项一\n- 项二'} t={t} />);
    expect(lastFrame()).toContain('标题');
    expect(lastFrame()).toContain('项一');
  });
  it('代码块含 lang 标签', () => {
    const { lastFrame } = render(<Md text={'\`\`\`ts\nconst a = 1;\n\`\`\`'} t={t} />);
    expect(lastFrame()).toContain('const a');
  });
  it('代码块带 ┌─ lang ┐ / └─┘ 闭合边框', () => {
    const { lastFrame } = render(<Md text={'\`\`\`ts\nconst a = 1;\n\`\`\`'} t={t} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('┌─ ts');
    expect(frame).toContain('│');
    expect(frame).toContain('└');
  });
  it('标题层级前缀 # / ## / ### 分级', () => {
    const { lastFrame } = render(<Md text={'# 一级\n\n## 二级\n\n### 三级'} t={t} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('# 一级');
    expect(frame).toContain('## 二级');
    expect(frame).toContain('### 三级');
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
    const cmds = Array.from({ length: 20 }, (_, i) => '/cmd' + i);
    expect(filterCommands('', cmds).length).toBe(6);
  });
  it('isSuggesting 判定 / 开头且无空格', () => {
    expect(isSuggesting('/hel')).toBe(true);
    expect(isSuggesting('/help x')).toBe(false);
    expect(isSuggesting('hello')).toBe(false);
    expect(isSuggesting('')).toBe(false);
  });
});

describe('状态条断点（statusBarSegments 纯函数）', () => {
  it('宽度分级：窄屏紧凑、宽屏全量', () => {
    const narrow = statusBarSegments(60);
    expect(narrow.bar).toBe(false);
    expect(narrow.compactCtx).toBe(true);
    const wide = statusBarSegments(100);
    expect(wide.bar).toBe(true);
    expect(wide.cost).toBe(true);
  });
});

describe('审批弹层（V3 ApprovalPrompt）', () => {
  const t = DEFAULT_THEME;
  it('allowPermanent 时含 Always allow', () => {
    const { lastFrame } = render(
      <ApprovalPrompt cols={80} req={{ command: 'rm -rf tmp', description: '运行命令', allowPermanent: true }} t={t} onChoice={() => {}} />
    );
    expect(lastFrame()).toContain('Always allow');
  });
  it('无 allowPermanent 时不渲染 Always allow', () => {
    const { lastFrame } = render(
      <ApprovalPrompt cols={80} req={{ command: 'rm -rf tmp', description: '运行命令', allowPermanent: false }} t={t} onChoice={() => {}} />
    );
    expect(lastFrame()).not.toContain('Always allow');
  });
});

describe('命令面板（V3 Ctrl+K CommandPalette）', () => {
  const gw = {
    request: async (method: string) => {
      if (method === 'commands.catalog') {
        return { pairs: [['/help', '查看帮助'], ['/usage', '用量统计']] as Array<[string, string]> };
      }
      if (method === 'skills.manage') {
        return { skills: { 工具: ['repo-map'] } };
      }
      if (method === 'session.active_list') {
        return { sessions: [{ id: 's1', title: '测试会话' }] };
      }
      return {};
    }
  } as any;
  it('三路数据渲染：命令/技能/会话条目', async () => {
    const { lastFrame, unmount } = render(
      <CommandPalette cols={80} currentSessionId="s1" gw={gw} onClose={() => {}} onSessionSelect={() => {}} onSubmit={() => {}} t={DEFAULT_THEME} />
    );
    await new Promise(r => setTimeout(r, 120));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('命令面板');
    expect(frame).toContain('/help');
    expect(frame).toContain('repo-map');
    expect(frame).toContain('测试会话');
    unmount();
  });
});
