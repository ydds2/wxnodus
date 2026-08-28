// src/wxnodus-ui/lib/wordDiff.ts — 词级 inline diff + hunk 跳转（波 2 ③ 6→7，纯函数可单测）
// kimi diff_render.py:184-218 对标：连续 -/+ 块逐对配对、SequenceMatcher 相似度 <0.5 跳过
// 配对（整行渲染）、delete/replace→旧行词级红、insert/replace→新行词级绿；无语法高亮层
// 故省略 tab 偏移映射（_build_offset_map 是语法高亮专属——诚实简化）。
// opencode diff-viewer.tsx:282-315 对标：hunk 跳转纯函数（pager [/] 键位消费）。
import type { DiffLine } from './diffHighlight.js'

export interface WordToken {
  text: string
  kind: 'same' | 'del' | 'add'
}

export const INLINE_DIFF_MIN_RATIO = 0.5
/** 词级配对单行长度上限（LCS 为 O(n²)——超长行直接整行渲染，kimi 同款保护思路） */
export const INLINE_DIFF_MAX_LEN = 240

/** char 级 LCS 长度（双行 DP 滚动，O(n·m) 时间 / O(min) 空间；超长行回 0=不相似） */
export function lcsLength(a: string, b: string): number {
  if (a.length > INLINE_DIFF_MAX_LEN || b.length > INLINE_DIFF_MAX_LEN) return 0
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let prev = new Array<number>(short.length + 1).fill(0)
  for (let i = 1; i <= long.length; i++) {
    const cur = new Array<number>(short.length + 1).fill(0)
    for (let j = 1; j <= short.length; j++) {
      cur[j] = long[i - 1] === short[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!)
    }
    prev = cur
  }
  return prev[short.length]!
}

/** SequenceMatcher.ratio 等价（kimi 阈值判定） */
export function inlineDiffRatio(a: string, b: string): number {
  const total = a.length + b.length
  if (total === 0) return 1
  return (2 * lcsLength(a, b)) / total
}

/** 旧行/新行 → 词级 token 流（char 级 LCS 回溯，相邻同类 token 合并；相似度不足 → 整行 del/add） */
export function wordDiffPair(oldText: string, newText: string): { old: WordToken[]; new: WordToken[] } {
  if (inlineDiffRatio(oldText, newText) < INLINE_DIFF_MIN_RATIO) {
    return {
      old: oldText ? [{ text: oldText, kind: 'del' }] : [],
      new: newText ? [{ text: newText, kind: 'add' }] : [],
    }
  }
  // 全矩阵回溯（长度已限 240，O(n·m) 安全）
  const n = oldText.length
  const m = newText.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = oldText[i - 1] === newText[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  // 从尾回溯收集（字符序倒置），随后反转再合并——顺序敏感
  const trail: Array<{ ch: string; kind: WordToken['kind']; which: 'old' | 'new' }> = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (oldText[i - 1] === newText[j - 1]) {
      trail.push({ ch: oldText[i - 1]!, kind: 'same', which: 'old' })
      trail.push({ ch: newText[j - 1]!, kind: 'same', which: 'new' })
      i--
      j--
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      trail.push({ ch: oldText[i - 1]!, kind: 'del', which: 'old' })
      i--
    } else {
      trail.push({ ch: newText[j - 1]!, kind: 'add', which: 'new' })
      j--
    }
  }
  while (i > 0) {
    trail.push({ ch: oldText[i - 1]!, kind: 'del', which: 'old' })
    i--
  }
  while (j > 0) {
    trail.push({ ch: newText[j - 1]!, kind: 'add', which: 'new' })
    j--
  }
  trail.reverse()
  const push = (arr: WordToken[], text: string, kind: WordToken['kind']) => {
    if (!text) return
    const last = arr[arr.length - 1]
    if (last && last.kind === kind) last.text += text
    else arr.push({ text, kind })
  }
  const oldOut: WordToken[] = []
  const newOut: WordToken[] = []
  for (const t of trail) {
    push(t.which === 'old' ? oldOut : newOut, t.ch, t.kind)
  }
  return { old: oldOut, new: newOut }
}

export type HunkBodyItem =
  | { kind: 'ctx' | 'del' | 'add'; line: DiffLine }
  | { kind: 'pair'; del: DiffLine; add: DiffLine; old: WordToken[]; new: WordToken[] }

/** hunk 体 → 配对项（kimi _highlight_hunk 同款：连续 - 块 + 连续 + 块按序配对，
 *  多出的单侧行原样；非 ± 行 ctx） */
export function pairHunkBody(body: DiffLine[]): HunkBodyItem[] {
  const out: HunkBodyItem[] = []
  let i = 0
  while (i < body.length) {
    const line = body[i]!
    if (line.kind === 'del') {
      let dEnd = i
      while (dEnd < body.length && body[dEnd]!.kind === 'del') dEnd++
      let aEnd = dEnd
      while (aEnd < body.length && body[aEnd]!.kind === 'add') aEnd++
      const dels = body.slice(i, dEnd)
      const adds = body.slice(dEnd, aEnd)
      const paired = Math.min(dels.length, adds.length)
      for (let k = 0; k < paired; k++) {
        const { old, new: nw } = wordDiffPair(dels[k]!.text, adds[k]!.text)
        out.push({ kind: 'pair', del: dels[k]!, add: adds[k]!, old, new: nw })
      }
      for (let k = paired; k < dels.length; k++) out.push({ kind: 'del', line: dels[k]! })
      for (let k = paired; k < adds.length; k++) out.push({ kind: 'add', line: adds[k]! })
      i = aEnd
    } else {
      out.push({ kind: line.kind === 'add' ? 'add' : 'ctx', line })
      i++
    }
  }
  return out
}

/** hunk 跳转（opencode diff-viewer.tsx:282-315 对标）：从 offset 向 dir 找下一个
 *  `@@ -` 行；无更多 hunk → null（调用方保持原位）。offset 结果夹取到 [0, max]。 */
export function hunkJump(lines: string[], offset: number, dir: 1 | -1, pageSize: number): number | null {
  const isHunk = (l: string) => /^@@ -\d/.test(l.trim())
  const max = Math.max(0, lines.length - pageSize)
  if (dir === 1) {
    for (let i = offset + 1; i < lines.length; i++) {
      if (isHunk(lines[i]!)) return Math.max(0, Math.min(i, max))
    }
    return null
  }
  for (let i = offset - 1; i >= 0; i--) {
    if (isHunk(lines[i]!)) return Math.max(0, Math.min(i, max))
  }
  return null
}
