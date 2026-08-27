// tests/tui-ansi-renderer.test.ts — P2 / Q1（2026-08-27）：薄层 TUI 渲染器纯函数
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  renderBanner,
  renderFinalLine,
  renderNoticeLine,
  renderToolResultLine,
  renderToolStartLine,
  renderTurnSummaryLine,
  renderUserLine,
  // kimi code 风格（2026-08-28）
  renderToolHeadline,
  renderToolOutcomeLine,
  renderCollapsedToolLine,
  renderThinkingLive,
  renderComposingLive,
  renderThoughtFinal,
  renderNotification,
  renderToolbar,
} from '../src/presentation/tui/ansiRenderer.js';

describe('TUI ansiRenderer（纯函数）', () => {
  it('colors=false 输出纯文本（管道/非 TTY 零 ANSI 乱码）', () => {
    const opts = { colors: false };
    expect(renderUserLine('你好', opts)).toBe('❯ 你好');
    expect(renderToolStartLine('fs_read', '{"path":"a"}', opts)).toContain('⏺ fs_read');
    expect(renderNoticeLine('通知', 'info', opts)).toBe('◈ 通知');
    expect(renderBanner('m', opts)).not.toMatch(/\x1b\[/);
    expect(renderFinalLine('succeeded', true, opts)).toBe('✓ 完成');
  });

  it('colors=true 语义色：失败红 / 拒绝黄 / 缓存灰 + ⟳ 字形', () => {
    const opts = { colors: true };
    expect(renderToolResultLine('failed', 'x', opts)).toContain(COLORS.error);
    expect(renderToolResultLine('denied', 'x', opts)).toContain(COLORS.warn);
    expect(renderToolResultLine('cached', 'x', opts)).toContain('⟳');
    expect(renderToolResultLine('timeout', 'x', opts)).toContain('⏱');
    expect(renderNoticeLine('危险', 'error', opts)).toContain(COLORS.error);
    expect(renderFinalLine('failed', false, opts)).toContain('✗');
    expect(renderFinalLine('failed', false, opts)).toContain(COLORS.error);
  });

  it('工具结果预览：换行折叠为单行 + 超长截断标注', () => {
    const long = 'a'.repeat(300);
    const line = renderToolResultLine('ok', `多行\n内容${long}`, { colors: false });
    expect(line).not.toContain('\n');
    expect(line).toContain('…');
  });

  it('回合摘要：轮次/时长组合', () => {
    expect(renderTurnSummaryLine({ turns: 3, durationMs: 1234 }, { colors: false })).toBe('◦ 3 轮 · 1.2s');
    expect(renderTurnSummaryLine({}, { colors: false })).toBe('');
    expect(renderTurnSummaryLine({ turns: 1, tokens: 28500 }, { colors: false })).toBe('◦ 1 轮 · 28.5k tokens'); // 紧凑 token 格式
  });
});

describe('kimi code 风格渲染（2026-08-28）', () => {
  it('工具头行：Using/Used + 工具名蓝 + 参数灰括号；colors=false 纯文本', () => {
    const on = renderToolHeadline('start', 'fs_read', 'a.txt', { colors: true });
    expect(on).toContain('Using');
    expect(on).toContain('\x1b[34mfs_read\x1b[0m'); // kimi 工具名蓝
    expect(on).toContain('(a.txt)');
    const off = renderToolHeadline('complete', 'fs_read', 'a.txt', { colors: false });
    expect(off).toBe(' Used fs_read (a.txt)');
  });

  it('工具结果行：绿/红 bullet + 换行折叠单行', () => {
    expect(renderToolOutcomeLine(true, 'fs_read 完成 · 12ms', { colors: true })).toContain(COLORS.ok);
    expect(renderToolOutcomeLine(false, '失败：xx', { colors: true })).toContain(COLORS.error);
    const folded = renderToolOutcomeLine(true, 'a\nb', { colors: false });
    expect(folded).not.toContain('\n');
    expect(renderCollapsedToolLine(3, { colors: false })).toContain('3 more tool calls');
  });

  it('思考实时行：Thinking 斜体 + 点帧 + 耗时 + token + tok/s 心跳', () => {
    const line = renderThinkingLive({ tokens: 3000, elapsedMs: 5000, frame: '...', ratePerSec: 600 }, { colors: true });
    expect(line).toContain('Thinking');
    expect(line).toContain('\x1b[3m'); // italic
    expect(line).toContain('...');
    expect(line).toContain('5s');
    expect(line).toContain('3k tokens');
    expect(line).toContain('600 tok/s');
  });

  it('生成中行与思考收口行（kimi Composing... / Thought for 语义）', () => {
    const c = renderComposingLive({ tokens: 0, elapsedMs: 0, frame: '⠋' }, { colors: false });
    expect(c).toContain('Composing...');
    expect(c).toContain('<1s');
    const f = renderThoughtFinal({ tokens: 128000, elapsedMs: 90_000 }, { colors: false });
    expect(f).toBe('Thought for 1m 30s · 128k tokens');
  });

  it('通知：标题加粗着色 + 正文灰预览 2 行（severity 语义色）', () => {
    const err = renderNotification('error', '失败标题\n正文一\n正文二\n正文三', { colors: true });
    expect(err).toContain(COLORS.error);
    expect(err).toContain('\x1b[1m'); // 标题加粗
    expect(err).toContain('正文二');
    expect(err).not.toContain('正文三');
    expect(err).toContain('...');
    expect(renderNotification('info', '单行', { colors: false })).toBe('单行');
  });

  it('底栏：分隔线 + 模式(model ○) + cwd 分支 + 提示；窄终端降级', () => {
    const wide = renderToolbar({
      mode: 'agent', model: 'deepseek-chat', thinking: false, cwd: 'C:/Users/x/proj', branch: 'master',
      tip: '/help 查看全部命令', columns: 200,
    }, { colors: false });
    expect(wide).toContain('─'.repeat(200));
    expect(wide).toContain('agent (deepseek-chat ○)');
    expect(wide).toContain('C:/Users/x/proj master');
    expect(wide).toContain('/help 查看全部命令');
    const narrow = renderToolbar({ mode: 'agent', model: 'deepseek-chat', cwd: 'C:/very/long/path', tip: 'tip', columns: 24 }, { colors: false });
    expect(narrow.split('\n').pop()?.length).toBeLessThanOrEqual(24); // 降级后不超宽
    expect(narrow).toContain('agent'); // 至少保留模式名（kimi bare 语义）
  });
});
