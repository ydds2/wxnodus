// src/wxnodus-ui/lib/diffHighlight.test.ts — diff 语法高亮行分类（纯函数）
import { describe, expect, it } from 'vitest';
import { diffLines, stripDiffFence } from './diffHighlight.js';

describe('diffLines 行分类', () => {
  it('经典 unified diff 五行分类', () => {
    const body = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const x = 1',
      '-const y = 2',
      '+const y = 3',
      '+const z = 4',
    ].join('\n');

    const lines = diffLines(body);
    expect(lines.map(l => l.kind)).toEqual([
      'meta', 'meta', 'meta', 'meta',
      'hunk', 'context', 'del', 'add', 'add',
    ]);
    expect(lines[5]!.text).toBe(' const x = 1');
    expect(lines[7]!.text).toBe('+const y = 3');
  });

  it('+++/--- 带路径元行优先于 +/- 判定（不被误标为增删）；裸 ---/+++ 落回增删', () => {
    const lines = diffLines('+++ b/a.ts\n--- a/a.ts');
    expect(lines.every(l => l.kind === 'meta')).toBe(true);
    // 裸 +++/---（无空格路径）按前缀归 add/del（无路径的元行是畸形输入，不特殊照顾）
    const bare = diffLines('+++\n---');
    expect(bare[0]!.kind).toBe('add');
    expect(bare[1]!.kind).toBe('del');
  });

  it('空行/无前缀行归 context（不抛错）', () => {
    const lines = diffLines('\n\n  缩进行\n');
    expect(lines.every(l => l.kind === 'context')).toBe(true);
  });

  it('new file mode / similarity index 元行识别', () => {
    const lines = diffLines('new file mode 100644\ndeleted file mode 100644\nsimilarity index 90%');
    expect(lines.every(l => l.kind === 'meta')).toBe(true);
  });

  it('CRLF 行尾剥离（win32 常见）', () => {
    const lines = diffLines('+a\r\n-b\r\n');
    expect(lines[0]).toEqual({ kind: 'add', text: '+a' });
    expect(lines[1]).toEqual({ kind: 'del', text: '-b' });
  });
});

describe('stripDiffFence 围栏摘除', () => {
  it('```diff/```patch 围栏摘除；裸正文原样', () => {
    expect(stripDiffFence('```diff\n+a\n```')).toBe('+a');
    expect(stripDiffFence('```patch\n+a\n```')).toBe('+a');
    expect(stripDiffFence('+a')).toBe('+a');
  });

  it('无闭合围栏也宽容摘除（不吞内容）', () => {
    expect(stripDiffFence('```diff\n+a')).toBe('+a');
  });
});
