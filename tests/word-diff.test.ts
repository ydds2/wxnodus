// tests/word-diff.test.ts — 波 2 ③ 6→7：词级 inline diff + hunk 跳转（kimi diff_render.py:184-218 / opencode diff-viewer.tsx:282-315 对标）
import { describe, expect, it } from 'vitest'
import { hunkJump, inlineDiffRatio, pairHunkBody, wordDiffPair, INLINE_DIFF_MIN_RATIO } from '../src/wxnodus-ui/lib/wordDiff.js'
import type { DiffLine } from '../src/wxnodus-ui/lib/diffHighlight.js'

const L = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text })

describe('wordDiffPair（kimi SequenceMatcher 移植）', () => {
  it('单点变更：same 前缀 + del 旧词 + add 新词 + same 后缀', () => {
    const { old: o, new: n } = wordDiffPair('const target = 42;', 'const target = 99;')
    expect(o.map(t => `${t.kind}:${t.text}`)).toEqual(['same:const target = ', 'del:42', 'same:;'])
    expect(n.map(t => `${t.kind}:${t.text}`)).toEqual(['same:const target = ', 'add:99', 'same:;'])
  })

  it('相似度 < 0.5 → 整行 del/add（不做词级配对）', () => {
    expect(inlineDiffRatio('a'.repeat(20), 'b'.repeat(20))).toBeLessThan(INLINE_DIFF_MIN_RATIO)
    const { old: o, new: n } = wordDiffPair('aaaaaaaaaaaa', 'bbbbbbbbbbbb')
    expect(o).toEqual([{ text: 'aaaaaaaaaaaa', kind: 'del' }])
    expect(n).toEqual([{ text: 'bbbbbbbbbbbb', kind: 'add' }])
  })

  it('超长行（>240）整行降级（LCS O(n²) 保护）', () => {
    const { old: o } = wordDiffPair('x'.repeat(300), 'x'.repeat(300) + 'y')
    expect(o).toEqual([{ text: 'x'.repeat(300), kind: 'del' }])
  })

  it('相同行 → 全 same；空行边界安全', () => {
    const { old: o, new: n } = wordDiffPair('same', 'same')
    expect(o).toEqual([{ text: 'same', kind: 'same' }])
    expect(n).toEqual([{ text: 'same', kind: 'same' }])
    expect(wordDiffPair('', '').old).toEqual([])
  })
})

describe('pairHunkBody（kimi _highlight_hunk 配对规则）', () => {
  it('连续 -/+ 块逐对配对；多出的单侧行原样保留', () => {
    const body = [L('del', '-a1'), L('del', '-a2'), L('add', '+b1'), L('context', ' c'), L('add', '+only')]
    const items = pairHunkBody(body)
    expect(items.map(i => i.kind)).toEqual(['pair', 'del', 'ctx', 'add'])
    expect((items[0] as any).del.text).toBe('-a1')
    expect((items[0] as any).add.text).toBe('+b1')
    expect((items[1] as any).line.text).toBe('-a2') // 多余的 del 原样
    expect((items[3] as any).line.text).toBe('+only') // 块外孤立 add 原样
  })

  it('配对行 token 流：变更词 red/green 分段（-/+ 前缀字符并入变更段）', () => {
    const items = pairHunkBody([L('del', '-old thing'), L('add', '+new thing')])
    const pair = items[0] as { kind: 'pair'; old: Array<{ kind: string; text: string }>; new: Array<{ kind: string; text: string }> }
    expect(pair.kind).toBe('pair')
    expect(pair.old.find(t => t.kind === 'del')!.text).toBe('-old')
    expect(pair.new.find(t => t.kind === 'add')!.text).toBe('+new')
    expect(pair.old.find(t => t.kind === 'same')!.text).toContain('thing')
  })
})

describe('hunkJump（opencode pager hunk 跳转）', () => {
  const LINES = ['标题', '@@ -1,2 +1,2 @@', ' ctx', '@@ -10,2 +10,2 @@', '+x', '@@ -20,1 +20,1 @@', '-y']

  it('] 向后跳下一个 hunk、[ 向前跳上一个；夹取到 [0, max]', () => {
    expect(hunkJump(LINES, 0, 1, 3)).toBe(1)
    expect(hunkJump(LINES, 1, 1, 3)).toBe(3)
    expect(hunkJump(LINES, 5, -1, 3)).toBe(3)
  })

  it('无更多 hunk → null（调用方保持原位）', () => {
    expect(hunkJump(LINES, 5, 1, 3)).toBeNull()
    expect(hunkJump(LINES, 0, -1, 3)).toBeNull()
  })

  it('非 hunk 行（@@ 无数字）不误跳', () => {
    expect(hunkJump(['@@ -1 +1 @@', '普通 @@ 文本', '@@ -3,1 +3,1 @@'], 0, 1, 2)).toBe(1)
  })
})
