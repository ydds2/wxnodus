// tests/hunk-apply.test.ts — 波 3 ③ 7→8：逐 hunk 应用（六家皆无的差异化——parseHunks/applyHunkToText/lineDiff）
import { describe, expect, it } from 'vitest'
import { applyHunkToText, lineDiff, parseHunks } from '../src/kernel/hunkApply.js'

const DIFF = `diff --git a/f.ts b/f.ts
index 111..222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const target = 42;
+const target = 99;
 const b = 2;
@@ -10,2 +10,2 @@
 ctx
-old tail
+new tail
`

describe('parseHunks（@@ 头结构化）', () => {
  it('多 hunk + meta 行忽略 + 行号/行数解析', () => {
    const hunks = parseHunks(DIFF)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.oldStart).toBe(1)
    expect(hunks[0]!.oldCount).toBe(3)
    expect(hunks[0]!.newStart).toBe(1)
    expect(hunks[0]!.lines.map(l => l.kind)).toEqual(['context', 'del', 'add', 'context'])
    expect(hunks[1]!.oldStart).toBe(10)
    expect(hunks[1]!.oldCount).toBe(2)
  })

  it('缺省计数段（@@ -3 +3 @@）→ 1；新文件 @@ -0,0 保留', () => {
    const hunks = parseHunks('@@ -3 +3 @@\n-old\n+new\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n')
    expect(hunks[0]!.oldCount).toBe(1)
    expect(hunks[0]!.newCount).toBe(1)
    expect(hunks[1]!.oldStart).toBe(0)
    expect(hunks[1]!.lines.filter(l => l.kind === 'add')).toHaveLength(2)
  })
})

describe('applyHunkToText（上下文锚定，失败绝不写半行）', () => {
  const CONTENT = 'const a = 1;\nconst target = 42;\nconst b = 2;\nconst c = 3;\n'

  it('精确锚定命中 → 替换成功', () => {
    const h = parseHunks('@@ -1,3 +1,3 @@\n const a = 1;\n-const target = 42;\n+const target = 99;\n const b = 2;\n')[0]!
    const r = applyHunkToText(CONTENT, h)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('const a = 1;\nconst target = 99;\nconst b = 2;\nconst c = 3;\n')
  })

  it('上下文不匹配 → 明确拒绝（文件已被改动）', () => {
    const h = parseHunks('@@ -2,1 +2,1 @@\n const xxx;\n-const target = 42;\n+const target = 99;\n')[0]!
    const r = applyHunkToText('completely different\nfile\n', h)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('上下文不匹配')
  })

  it('@@ -0,0 新文件 hunk → 纯新增到指定行', () => {
    const h = parseHunks('@@ -0,0 +1,2 @@\n+alpha\n+beta\n')[0]!
    const r = applyHunkToText('line1\nline2\n', h)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('alpha\nbeta\nline1\nline2\n')
  })

  it('hunk 应用后再应用第二个（顺序应用幂等失败——行号漂移诚实报错）', () => {
    const hunks = parseHunks('@@ -1,2 +1,2 @@\n-old1\n-old2\n+new1\n+new2\n@@ -3,1 +3,1 @@\n-old3\n+new3\n')
    const r1 = applyHunkToText('old1\nold2\nold3\n', hunks[0]!)
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.text).toBe('new1\nnew2\nold3\n')
      const r2 = applyHunkToText(r1.text, hunks[1]!)
      expect(r2.ok).toBe(true)
      if (r2.ok) expect(r2.text).toBe('new1\nnew2\nnew3\n')
    }
  })
})

describe('lineDiff（快照对比数据源）', () => {
  it('多段变更生成多 hunk（3 行上下文；间隔 > 2×CTX 才分 hunk）', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')
    const next = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K'].join('\n')
    const d = lineDiff(old, next)
    expect(d).toContain('-c')
    expect(d).toContain('+C')
    expect(d).toContain('-k')
    expect(d).toContain('+K')
    expect(parseHunks(d).length).toBe(2) // 间隔 7 行 > 6 → 两个 hunk
  })

  it('无变更 → 空串；完全相同 → 空 diff', () => {
    expect(lineDiff('a\nb', 'a\nb')).toBe('')
  })

  it('超限降级：整文件 ±（诚实标注省略行）', () => {
    const big = Array.from({ length: 1600 }, (_, i) => `line${i}`).join('\n')
    const d = lineDiff(big, big + '\nlast')
    expect(d.startsWith('@@ -1,1600 +1,1601 @@')).toBe(true)
    expect(d).toContain('+last')
  })
})
