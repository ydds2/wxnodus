// tests/diff-gutter.test.ts — ③ 波 1：diff 行号排水沟纯函数（gemini DiffRenderer 移植）
import { describe, expect, it } from 'vitest'
import { hasDiffHunks, diffBodyOf, lineNumbersFor, type GutterLine } from '../src/wxnodus-ui/lib/diffGutter.js'

const L = (kind: GutterLine['kind'], text: string): GutterLine => ({ kind, text })

describe('lineNumbersFor（@@ 头驱动的行号排水沟）', () => {
  it('hunk 内按新侧行号递增；del 行右侧留空；hunk 外 null（git 右侧排水沟语义）', () => {
    const lines = [
      L('meta', 'diff --git a/x b/x'),
      L('hunk', '@@ -10,4 +20,5 @@'),
      L('context', ' ctx'),
      L('del', '-old'),
      L('add', '+new'),
      L('context', ' ctx2'),
      L('hunk', '@@ -50,2 +60,2 @@'),
      L('add', '+tail'),
      L('context', ' end'),
    ]
    expect(lineNumbersFor(lines)).toEqual([null, null, 20, null, 21, 22, null, 60, 61])
  })

  it('新文件（@@ -0,0 +1,N @@）从 1 起算', () => {
    const lines = [L('hunk', '@@ -0,0 +1,3 @@'), L('add', '+a'), L('add', '+b'), L('add', '+c')]
    expect(lineNumbersFor(lines)).toEqual([null, 1, 2, 3])
  })

  it('无 hunk（纯上下文/无 @@ 头）→ 全 null（渲染层不画 gutter）', () => {
    expect(lineNumbersFor([L('context', 'x'), L('meta', '--- a')])).toEqual([null, null])
  })
})

describe('diff 检测（工具结果/正文混排）', () => {
  it('hasDiffHunks：`@@ -` 起首才认（普通 @ 文本不误判）', () => {
    expect(hasDiffHunks('@@ -1,2 +1,2 @@\n-x\n+y')).toBe(true)
    expect(hasDiffHunks('前置文本\n@@ -1 +1 @@')).toBe(true)
    expect(hasDiffHunks('email: a@@b-c.com')).toBe(false)
    expect(hasDiffHunks('@@ 无减号')).toBe(false)
  })

  it('diffBodyOf：hunk 头 + 变更行双条件；grep 输出恰含 @@ - 不误判', () => {
    expect(diffBodyOf('已替换 a.txt 中 1 处\n@@ -3,1 +3,1 @@\n-old\n+new')).toBe('@@ -3,1 +3,1 @@\n-old\n+new')
    // grep 输出里出现 @@ - 字样但没有 +/- 变更行 → null（保守不误判）
    expect(diffBodyOf('a.md:12:@@ -1,2 +1,2 @@ 的文字说明')).toBeNull()
    expect(diffBodyOf('普通文本无 diff')).toBeNull()
  })
})
