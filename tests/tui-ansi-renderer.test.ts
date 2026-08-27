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
  });
});
