// tests/tui-theme.test.ts — 薄层 TUI 主题与文本度量（kimi code 风格化，2026-08-28）
import { describe, expect, it } from 'vitest';
import {
  themeTokens, charWidth, displayWidth, truncateLeft, truncateRight,
  formatElapsed, formatTokenCount, estimateTokens,
  THINK_BULLET_FRAMES, thinkBulletFrameAt, SPINNER_FRAMES, spinnerFrameAt,
} from '../src/presentation/tui/theme.js';

describe('themeTokens（kimi 暗/亮主题语义）', () => {
  it('dark 默认：工具名蓝 / 参数灰 / 成功绿 / 失败红（kimi "Used Read" 蓝色工具名语义）', () => {
    const t = themeTokens('dark');
    expect(t.tool).toBe('\x1b[34m');
    expect(t.ok).toBe('\x1b[32m');
    expect(t.error).toBe('\x1b[31m');
  });
  it('light 与 dark 令牌结构一致（集中主题令牌可切换）', () => {
    const light = themeTokens('light');
    const dark = themeTokens('dark');
    expect(Object.keys(light)).toEqual(Object.keys(dark));
  });
});

describe('displayWidth / charWidth（CJK 感知列宽）', () => {
  it('ASCII=1、中文=2、emoji=2、零宽/组合标记=0', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(charWidth('✅')).toBe(2);
    expect(charWidth('\u200b')).toBe(0); // 零宽空格
    expect(charWidth('\u0301')).toBe(0); // 组合重音
  });
});

describe('truncateRight / truncateLeft（kimi _truncate_* 语义）', () => {
  it('右侧截断按列宽加 …；不足不截', () => {
    expect(truncateRight('abcdef', 4)).toBe('abc…');
    expect(truncateRight('ab', 4)).toBe('ab');
    expect(truncateRight('中文中文', 5)).toBe('中文…'); // 4 列预算恰好放 2 个全角字
    expect(truncateRight('x', 0)).toBe('');
  });
  it('左侧截断按列宽加 …（cwd 徽标左截语义）', () => {
    expect(truncateLeft('abcdef', 4)).toBe('…def');
    expect(truncateLeft('ab', 4)).toBe('ab');
    expect(truncateLeft('中文中文', 5)).toBe('…中文');
  });
});

describe('formatElapsed（kimi utils/datetime 语义）', () => {
  it('0.5→<1s、5→5s、90→1m 30s、3661→1h 1m 1s', () => {
    expect(formatElapsed(0.5)).toBe('<1s');
    expect(formatElapsed(5)).toBe('5s');
    expect(formatElapsed(90)).toBe('1m 30s');
    expect(formatElapsed(3661)).toBe('1h 1m 1s');
  });
});

describe('formatTokenCount（kimi soul 语义：28.5k/128k/1.2m）', () => {
  it('紧凑计数', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(28500)).toBe('28.5k');
    expect(formatTokenCount(128000)).toBe('128k');
    expect(formatTokenCount(1_200_000)).toBe('1.2m');
  });
});

describe('estimateTokens（kimi _estimate_tokens 语义：CJK≈1.5/字 + Latin≈1/4 字）', () => {
  it('混合文本估算为浮点（小块不截断为 0）', () => {
    expect(estimateTokens('中文')).toBe(3);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('中a')).toBe(1.75);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('动画帧（kimi _bullet_frame_for / Spinner 语义）', () => {
  it('思考点帧 6 帧 130ms 循环、spinner 10 帧 80ms 循环（墙上时钟选帧）', () => {
    expect(THINK_BULLET_FRAMES).toHaveLength(6);
    expect(thinkBulletFrameAt(0)).toBe(THINK_BULLET_FRAMES[0]);
    expect(thinkBulletFrameAt(130)).toBe(THINK_BULLET_FRAMES[1]);
    expect(thinkBulletFrameAt(130 * 6)).toBe(THINK_BULLET_FRAMES[0]); // 循环
    expect(SPINNER_FRAMES).toHaveLength(10);
    expect(spinnerFrameAt(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrameAt(80 * 10)).toBe(SPINNER_FRAMES[0]);
  });
});
