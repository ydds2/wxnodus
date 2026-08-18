// tests/diff-hunks.test.ts — supremacy 3.3 diff hunk 折叠/应用（B-02）：分节/折叠段/默认折叠/切换/补丁还原
import { describe, it, expect } from 'vitest';
import { diffLines, stripDiffFence } from '../src/wxnodus-ui/lib/diffHighlight.js';
import {
  groupDiffSections, buildFoldSegments, withDefaultFolds, toggleFold, extractPatchText,
} from '../src/wxnodus-ui/lib/diffHunks.js';

const BODY = [
  '```diff',
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' context-1',
  '-old line',
  '+new line',
  ' context-2',
  '@@ -10,2 +10,2 @@',
  ' ctx',
  '-x',
  '+y',
  '```',
].join('\n');

describe('groupDiffSections（文件节/hunk 分组）', () => {
  it('两 hunk 归同一文件节；meta 行归节头', () => {
    const secs = groupDiffSections(diffLines(stripDiffFence(BODY)));
    expect(secs).toHaveLength(1);
    expect(secs[0]!.meta.map(m => m.text)).toEqual(['diff --git a/a.ts b/a.ts', 'index 111..222 100644', '--- a/a.ts', '+++ b/a.ts']);
    expect(secs[0]!.hunks).toHaveLength(2);
    expect(secs[0]!.hunks[0]!.header.text).toBe('@@ -1,3 +1,3 @@');
    expect(secs[0]!.hunks[0]!.body.map(l => l.text)).toEqual([' context-1', '-old line', '+new line', ' context-2']);
    expect(secs[0]!.hunks[1]!.body.map(l => l.text)).toEqual([' ctx', '-x', '+y']);
  });
  it('新文件头出现 → 开新节', () => {
    const two = `${BODY}\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new`;
    const secs = groupDiffSections(diffLines(stripDiffFence(two)));
    expect(secs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildFoldSegments / withDefaultFolds / toggleFold', () => {
  const segs = () => buildFoldSegments(diffLines(stripDiffFence(BODY)));
  it('meta 合并单段 + 每 hunk 一段（默认全展开）', () => {
    const s = segs();
    expect(s).toHaveLength(3);
    expect(s[0]!.kind).toBe('meta');
    expect(s[1]!.kind).toBe('hunk');
    expect(s[2]!.kind).toBe('hunk');
    expect(s.every(x => x.kind === 'meta' || x.folded === false)).toBe(true);
  });
  it('withDefaultFolds：超长 hunk 默认折叠（首屏友好）', () => {
    const long = ['@@ -1,30 +1,30 @@', ...Array.from({ length: 25 }, (_, i) => ` line${i}`)].join('\n');
    const s = withDefaultFolds(buildFoldSegments(diffLines(long)), 20);
    expect(s.find(x => x.kind === 'hunk')!.folded).toBe(true);
    // 短 hunk 不受影响
    const s2 = withDefaultFolds(segs(), 20);
    expect(s2.every(x => x.kind !== 'hunk' || x.folded === false)).toBe(true);
  });
  it('toggleFold：hunk 折叠态切换 + meta 不可折叠 + 不可变', () => {
    const s = withDefaultFolds(segs(), 1); // 全部 hunk 折叠
    const toggled = toggleFold(s, 1);
    const t1 = toggled[1]!;
    const s1 = s[1]!;
    expect(t1.kind === 'hunk' && t1.folded).toBe(false);
    expect(s1.kind === 'hunk' && s1.folded).toBe(true); // 原数组不变（纯函数）
    const metaToggled = toggleFold(s, 0);
    expect(metaToggled[0]).toEqual(s[0]);
  });
});

describe('extractPatchText（apply_patch 输入源）', () => {
  it('还原原始补丁文本（与 diffLines 互逆）', () => {
    const text = stripDiffFence(BODY);
    const restored = extractPatchText(diffLines(text));
    expect(restored).toBe(text.replace(/\r/g, ''));
  });
});
