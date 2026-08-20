// src/wxnodus-ui/lib/diffSummary.test.ts — 修改分区数据投影（纯函数）
import { describe, expect, it } from 'vitest';
import { changesLabel, diffSummary } from './diffSummary.js';
import type { Msg } from '../types.js';

const diffMsg = (text: string): Msg => ({ kind: 'diff', role: 'assistant', text });

describe('diffSummary 纯函数', () => {
  it('解析单文件 diff：路径、+/- 计数、body 保留', () => {
    const s = diffSummary([diffMsg('```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n```')]);

    expect(s.files).toHaveLength(1);
    expect(s.files[0]).toMatchObject({ path: 'src/a.ts', added: 1, removed: 1 });
    expect(s.added).toBe(1);
    expect(s.removed).toBe(1);
    expect(s.files[0]!.body).toContain('+new');
  });

  it('多文件聚合 + 连续 diff 段按同路径合并计数', () => {
    const s = diffSummary([
      diffMsg('```diff\n--- a/x\n+++ b/x\n@@\n-a\n+b\n```'),
      diffMsg('```diff\n--- a/y\n+++ b/y\n@@\n-c\n+d\n+e\n```'),
      diffMsg('```diff\n--- a/x\n+++ b/x\n@@\n-f\n```'),
    ]);

    expect(s.files).toHaveLength(2);
    expect(s.files.find(f => f.path === 'x')).toMatchObject({ added: 1, removed: 2 });
    expect(s.files.find(f => f.path === 'y')).toMatchObject({ added: 2, removed: 1 });
    expect(s.added).toBe(3);
    expect(s.removed).toBe(3);
  });

  it('非 diff 段忽略；无路径的块忽略（不吞内容也不制造假变更）', () => {
    expect(diffSummary([{ role: 'assistant', text: '普通叙述' } as Msg]).files).toEqual([]);
    expect(diffSummary([diffMsg('```diff\n@@\n-old\n+new\n```')]).files).toEqual([]);
    expect(diffSummary([]).files).toEqual([]);
  });

  it('changesLabel：低噪声一行摘要', () => {
    const s = diffSummary([diffMsg('```diff\n--- a/x\n+++ b/x\n@@\n-a\n+b\n+c\n```')]);
    expect(changesLabel(s)).toBe('修改 1 个文件 · +2 -1');
    expect(changesLabel(diffSummary([]))).toBe('');
  });
});
