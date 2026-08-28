// tests/tui-ansi-renderer.test.ts — P2 / Q1（2026-08-27）：薄层 TUI 渲染器纯函数
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  hasUnifiedDiff,
  splitCommon,
  renderDiffPreview,
  renderToolbar,
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

// T8/T9（2026-08-28）：diff 红绿渲染 + 底栏会话 token 段
describe('T8：统一 diff 红绿渲染', () => {
  const sample = '已替换 src/a.ts 中 1 处\n@@ -10,2 +10,2 @@\n const x = 1;\n-const old = 2;\n+const next = 3;\n后续说明文字';
  it('hasUnifiedDiff：@@ 块与 diff --git 双形态识别；普通文本不误判', () => {
    expect(hasUnifiedDiff(sample)).toBe(true);
    expect(hasUnifiedDiff('diff --git a/x b/x\n--- a/x')).toBe(true);
    expect(hasUnifiedDiff('普通输出，无 diff')).toBe(false);
  });
  it('渲染：+ 行绿 / - 行红 / @@ 青 / 上下文 dim；消息与尾部说明不进块', () => {
    const out = renderDiffPreview(sample, { colors: true });
    expect(out).toContain('\x1b[36m@@ -10,2 +10,2 @@');
    // T10 词级分段：公共前缀段（-const ）+ 加粗中段（old = 2）+ 独立后缀段（\x1b[31m;）
    expect(out).toContain('\x1b[31m-const ');
    expect(out).toContain('\x1b[31m\x1b[1mold = 2');
    expect(out).toContain('\x1b[31m;');
    expect(out).toContain('\x1b[32m+const ');
    expect(out).toContain('\x1b[32m\x1b[1mnext = 3');
    expect(out).toContain('\x1b[90m const x = 1;');
    expect(out).not.toContain('已替换');
    expect(out).not.toContain('后续说明');
  });
  it('colors:false 纯文本形态（管道零 ANSI）', () => {
    const out = renderDiffPreview(sample, { colors: false });
    expect(out.split('\n')).toEqual(['@@ -10,2 +10,2 @@', ' const x = 1;', '-const old = 2;', '+const next = 3;']);
  });
});
describe('T9：底栏会话 token 段', () => {
  it('sessionTokens>0 → dim 段可见（formatTokenCount 千分位）', () => {
    const out = renderToolbar({ mode: 'agent', model: 'm', sessionTokens: 1234, columns: 120 }, { colors: true });
    expect(out).toContain('1.2k tok');
  });
  it('sessionTokens 缺省/0 → 不出现段（首回合前不占宽）', () => {
    expect(renderToolbar({ mode: 'agent', columns: 120 }, { colors: false })).not.toContain('tok');
    expect(renderToolbar({ mode: 'agent', sessionTokens: 0, columns: 120 }, { colors: false })).not.toContain('tok');
  });
  it('窄终端降级链：tip 先让位，token 段保留且总宽受控', () => {
    const out = renderToolbar({ mode: 'agent', sessionTokens: 99999, cwd: 'C:/very/long/path', tip: 'x'.repeat(40), columns: 30 }, { colors: false });
    const line = out.split('\n')[1]!;
    expect(line).not.toContain('xxxx'); // tip 已让位
    expect(line).toContain('100k tok'); // token 段仍在（次于 tip 的降级序）
    expect(line.length <= 30 + 12).toBe(true); // 宽度受控
  });
});

// T10（2026-08-28）：词级 diff 高亮——配对行公共前后缀剥离、中段加粗
describe('T10：词级 diff 高亮', () => {
  it('splitCommon：公共前后缀剥离正确（纯函数几何）', () => {
    expect(splitCommon('-const old = 2;', '-const next = 3;')).toEqual({ pre: '-const ', aMid: 'old = 2', bMid: 'next = 3', suf: ';' });
    expect(splitCommon('abcXY', 'abXYZ')).toEqual({ pre: 'ab', aMid: 'cXY', bMid: 'XYZ', suf: '' }); // 末字符 Y/Z 不匹配 → 后缀为空，中段吞掉全部差异
    expect(splitCommon('同头同尾', '同头x同尾')).toEqual({ pre: '同头', aMid: '', bMid: 'x', suf: '同尾' });
  });
  it('纯删行（无配对）保持整行红——不套词级', () => {
    const out = renderDiffPreview('@@ -1,1 +1,0 @@\n-only line', { colors: true });
    expect(out).toContain('\x1b[31m-only line');
  });
  it('colors:false 分段拼接 = 原行（管道纯文本不变）', () => {
    const out = renderDiffPreview('@@ -1,1 +1,1 @@\n-old x\n+new x', { colors: false });
    expect(out.split('\n')).toEqual(['@@ -1,1 +1,1 @@', '-old x', '+new x']);
  });
});
