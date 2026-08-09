// tests/markdown.test.ts — L6-1 Markdown 管线：解析（micromark→块模型）与流式增量切分
import { describe, it, expect } from 'vitest';
import { parseMd, type MdBlock } from '../src/ui/markdown/parse.js';
import { splitStablePrefix, throttleStreaming } from '../src/ui/markdown/streaming.js';

describe('parseMd 块模型', () => {
  it('标题/段落/列表/代码块', () => {
    const blocks = parseMd('# 标题\n\n正文\n\n- 项一\n- 项二\n\n```ts\nconst a = 1;\n```');
    expect(blocks[0].type).toBe('heading');
    expect((blocks[0] as any).depth).toBe(1);
    expect(blocks[1].type).toBe('paragraph');
    expect(blocks[2].type).toBe('list');
    expect(blocks[3].type).toBe('code');
    expect((blocks[3] as any).lang).toBe('ts');
  });
  it('流式容错：未闭合代码围栏按代码块处理', () => {
    const blocks = parseMd('```ts\nconst a = 1;');
    expect(blocks[0].type).toBe('code');
    expect((blocks[0] as any).lang).toBe('ts');
  });
  it('表格解析', () => {
    const blocks = parseMd('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(blocks[0].type).toBe('table');
  });
  it('数学块与引用', () => {
    const blocks = parseMd('$$E=mc^2$$\n\n> 引用内容');
    expect(blocks.some(b => b.type === 'math')).toBe(true);
    expect(blocks.some(b => b.type === 'quote')).toBe(true);
  });
  it('空输入不崩', () => {
    expect(parseMd('')).toEqual([]);
  });
});

describe('splitStablePrefix 流式增量', () => {
  it('稳定前缀到最后一个闭合块边界', () => {
    const { stable, unstable } = splitStablePrefix('第一段\n\n```ts\nconst a = 1;\n```\n\n第二段中');
    expect(stable).toBe('第一段\n\n```ts\nconst a = 1;\n```');
    expect(unstable).toBe('第二段中');
  });
  it('未闭合代码块整体不稳定', () => {
    const { stable, unstable } = splitStablePrefix('前文\n\n```ts\nconst a =');
    expect(stable).toBe('前文');
    expect(unstable).toContain('```');
  });
  it('无边界时全部不稳定', () => {
    const { stable, unstable } = splitStablePrefix('单段未完成');
    expect(stable).toBe('');
    expect(unstable).toBe('单段未完成');
  });
});

describe('throttleStreaming 节流', () => {
  it('16ms 内多次调度只执行一次', async () => {
    let n = 0;
    const t = throttleStreaming(16);
    t.schedule(() => n++);
    t.schedule(() => n++);
    t.schedule(() => n++);
    await new Promise(r => setTimeout(r, 40));
    expect(n).toBe(1); // 合并为一次
  });
  it('flush 立即执行', () => {
    let n = 0;
    const t = throttleStreaming(16);
    t.schedule(() => n++);
    t.flush();
    expect(n).toBe(1);
  });
});
