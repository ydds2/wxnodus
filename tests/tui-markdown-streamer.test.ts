// tests/tui-markdown-streamer.test.ts — 流式 Markdown 增量提交（kimi code 风格化，2026-08-28）
// 契约：只提交完整块——围栏闭合才提交、标题/分隔线自闭合即提交、段落空行收口、
// 列表/表格块结束收口；半行绝不判定（流中拆断安全）。
import { describe, expect, it } from 'vitest';
import { MarkdownStreamer } from '../src/presentation/tui/markdownStreamer.js';

const appendAll = (s: MarkdownStreamer, text: string): string[] => s.append(text);

describe('MarkdownStreamer（kimi 增量承诺语义的原创行状态机）', () => {
  it('段落：空行收口后才提交', () => {
    const s = new MarkdownStreamer();
    expect(appendAll(s, '第一段文字')).toEqual([]); // 半行不判定
    expect(appendAll(s, '继续\n')).toEqual([]);      // 段未收口
    expect(appendAll(s, '\n')).toEqual(['第一段文字继续\n\n']);
    expect(s.flush()).toEqual([]);
  });

  it('代码围栏：闭合才整块提交（未闭合内容绝不落盘）', () => {
    const s = new MarkdownStreamer();
    expect(appendAll(s, '```js\nconst a = 1;\n')).toEqual([]);
    expect(appendAll(s, 'console.log(a)\n')).toEqual([]);
    expect(appendAll(s, '```\n')).toEqual(['```js\nconst a = 1;\nconsole.log(a)\n```\n']);
  });

  it('标题与分隔线：自闭合单行立即提交', () => {
    const s = new MarkdownStreamer();
    expect(appendAll(s, '# 标题\n')).toEqual(['# 标题\n']);
    expect(appendAll(s, '---\n')).toEqual(['---\n']);
  });

  it('列表块：非列表行出现时整块提交；缩进续行属列表项', () => {
    const s = new MarkdownStreamer();
    expect(appendAll(s, '- a\n- b\n  nested\n')).toEqual([]);
    expect(appendAll(s, '正文\n')).toEqual(['- a\n- b\n  nested\n']);
  });

  it('表格块：非表格行出现时整块提交', () => {
    const s = new MarkdownStreamer();
    expect(appendAll(s, '| a | b |\n| 1 | 2 |\n')).toEqual([]);
    expect(appendAll(s, 'end\n')).toEqual(['| a | b |\n| 1 | 2 |\n']);
  });

  it('流中拆断安全：CRLF 归一 + 半行缓冲', () => {
    const s = new MarkdownStreamer();
    expect(appendAll(s, '段\r\n落')).toEqual([]);
    expect(appendAll(s, '续\r\n\r\n')).toEqual(['段\n落续\n\n']); // \r\n 归一为 \n 后整段提交
  });

  it('flush：未收口内容如实提交（含未闭合围栏按现状提交）', () => {
    const s = new MarkdownStreamer();
    appendAll(s, '未收口段落');
    expect(s.flush()).toEqual(['未收口段落\n']);
    const f = new MarkdownStreamer();
    appendAll(f, '```js\n半截代码');
    expect(f.flush()).toEqual(['```js\n半截代码\n']);
  });
});
