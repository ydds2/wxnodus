// src/kernel/hunkApply.ts — unified diff 解析 + 逐 hunk 应用（波 3 ③ 7→8）
// 六家皆无 per-hunk 应用（取证确认 opencode diff-viewer.tsx:945-1010 仅跳转无 apply/discard）
// ——wxnodus 差异化：/diff 查看快照 vs 当前文件，逐 hunk 选择应用（基于 undoShadows 回滚）。
// 纯函数可单测：parseHunks（@@ 头结构化）/ applyHunkToText（上下文锚定校验，失败绝不写半行）/
// lineDiff（行级 LCS unified diff，3 行上下文，超限降级整文件 ±）。

export interface HunkLine {
  kind: 'context' | 'add' | 'del'
  text: string
}

export interface ParsedHunk {
  /** 原始 @@ 头行（回显用） */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

/** diff 文本 → hunk 列表（@@ 头驱动；meta 行（diff --git 等）忽略；CRLF 剥离） */
export function parseHunks(diffText: string): ParsedHunk[] {
  const out: ParsedHunk[] = []
  let cur: ParsedHunk | null = null
  for (const raw of diffText.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m) {
      cur = {
        header: line,
        oldStart: Number(m[1]),
        oldCount: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newCount: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('-') && !line.startsWith('---')) cur.lines.push({ kind: 'del', text: line.slice(1) })
    else if (line.startsWith('+') && !line.startsWith('+++')) cur.lines.push({ kind: 'add', text: line.slice(1) })
    else if (line.startsWith(' ')) cur.lines.push({ kind: 'context', text: line.slice(1) })
    // 注：raw '' 行（diff 文本末尾换行产生的空串）不是合法 hunk 行——unified diff 空行
    // 以 ' ' 前缀表示；此处丢弃（否则每段末尾多一条幽灵 context 行）
  }
  return out
}

const oldSide = (h: ParsedHunk): string[] => h.lines.filter(l => l.kind !== 'add').map(l => l.text)
const newSide = (h: ParsedHunk): string[] => h.lines.filter(l => l.kind !== 'del').map(l => l.text)

/** hunk 反转（快照→当前 diff 的选择性回滚：new 侧 ↔ old 侧互换，+/− 行对调） */
export function reverseHunk(h: ParsedHunk): ParsedHunk {
  return {
    header: `@@ -${h.newStart},${h.newCount} +${h.oldStart},${h.oldCount} @@`,
    oldStart: h.newStart,
    oldCount: h.newCount,
    newStart: h.oldStart,
    newCount: h.oldCount,
    lines: h.lines.map(l => (l.kind === 'add' ? { kind: 'del' as const, text: l.text } : l.kind === 'del' ? { kind: 'add' as const, text: l.text } : l)),
  }
}

const linesOf = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n')

// V4 P1-9：探测原文本主行尾（CRLF 文件回写保持 CRLF——此前统一 join('\n') 使单 hunk 回滚
// 即整文件行尾翻转 LF，git 全文件 diff/老解析器炸；applyPatch.ts eol 保真同族语义）
const eolOf = (text: string): '\r\n' | '\n' => {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

/** 在 content 中定位 old 侧序列（先按 @@ 行号精确落点，失败全文回退首个匹配） */
function locateOld(contentLines: string[], h: ParsedHunk): number | null {
  const old = oldSide(h)
  if (!old.length) return null
  const at = (from: number): boolean => {
    if (from + old.length > contentLines.length) return false
    for (let i = 0; i < old.length; i++) {
      if (contentLines[from + i] !== old[i]) return false
    }
    return true
  }
  // 精确落点（oldStart 1-based；oldStart=0 表新文件——跳过）
  if (h.oldStart > 0) {
    const pos = h.oldStart - 1
    if (at(pos)) return pos
  }
  for (let i = 0; i + old.length <= contentLines.length; i++) {
    if (at(i)) return i
  }
  return null
}

export type HunkApplyResult = { ok: true; text: string } | { ok: false; error: string }

/** 单 hunk 应用到文本：old 侧（context+del）全量锚定匹配才替换为 new 侧（context+add）；
 *  不匹配 → 明确报错绝不写半行（codex verify-before-apply 同款纪律）。 */
export function applyHunkToText(content: string, h: ParsedHunk): HunkApplyResult {
  const eol = eolOf(content) // V4 P1-9：原行尾保真
  const contentLines = linesOf(content)
  const old = oldSide(h)
  const next = newSide(h)
  if (!old.length && !next.length) return { ok: false, error: 'hunk 为空（无任何行）' }
  // 新文件 hunk（@@ -0,0）：纯新增——插到指定行（默认文首）
  if (h.oldStart === 0 && h.oldCount === 0) {
    const at = Math.max(0, Math.min(h.newStart - 1, contentLines.length))
    const out = [...contentLines.slice(0, at), ...next, ...contentLines.slice(at)]
    return { ok: true, text: eol === '\r\n' ? out.join('\r\n') : out.join('\n') }
  }
  const pos = locateOld(contentLines, h)
  if (pos === null) {
    return { ok: false, error: `hunk 上下文不匹配（@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@）——文件已被改动或 hunk 顺序错误` }
  }
  const out = [...contentLines.slice(0, pos), ...next, ...contentLines.slice(pos + old.length)]
  return { ok: true, text: eol === '\r\n' ? out.join('\r\n') : out.join('\n') }
}

// ── 行级 LCS unified diff（/diff 快照对比数据源）────────────────
const MAX_DIFF_LINES = 1500

/** 行级 unified diff（3 行上下文；超限整文件 ± 降级——诚实标注省略） */
export function lineDiff(oldText: string, newText: string): string {
  const a = linesOf(oldText)
  const b = linesOf(newText)
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      `@@ -1,${a.length} +1,${b.length} @@`,
      ...a.map(l => `-${l}`),
      ...b.map(l => `+${l}`),
    ].join('\n')
  }
  // LCS 表
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  // 回溯 opcodes（equal/delete/insert）
  type Op = { kind: 'equal' | 'del' | 'add'; text: string }
  const ops: Op[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'equal', text: a[i - 1]! })
      i--
      j--
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: 'del', text: a[i - 1]! })
      i--
    } else {
      ops.push({ kind: 'add', text: b[j - 1]! })
      j--
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', text: a[i - 1]! })
    i--
  }
  while (j > 0) {
    ops.push({ kind: 'add', text: b[j - 1]! })
    j--
  }
  ops.reverse()
  // 切 hunk：变更段 ±3 行上下文
  const CTX = 3
  const hunks: string[] = []
  const changeIdx: number[] = []
  ops.forEach((op, idx) => {
    if (op.kind !== 'equal') changeIdx.push(idx)
  })
  if (!changeIdx.length) return ''
  // 连续变更段合并（间隙 ≤ 2*CTX 合并为一个 hunk）
  const ranges: Array<[number, number]> = []
  for (const c of changeIdx) {
    const last = ranges[ranges.length - 1]
    if (last && c - last[1] - 1 <= 2 * CTX) last[1] = c
    else ranges.push([c, c])
  }
  // ops[i] 之前的 old/new 行数（前缀和——@@ 头行号换算）
  const prefixCounts: Array<[number, number]> = []
  let oc = 0
  let nc = 0
  for (const op of ops) {
    prefixCounts.push([oc, nc])
    if (op.kind !== 'add') oc++
    if (op.kind !== 'del') nc++
  }
  for (const [s, e] of ranges) {
    const from = Math.max(0, s - CTX)
    const to = Math.min(ops.length - 1, e + CTX)
    const oStart = prefixCounts[from]![0] + 1
    const oCount = prefixCounts[to]![0] + (ops[to]!.kind !== 'add' ? 1 : 0) - oStart + 1
    const nStart = prefixCounts[from]![1] + 1
    const nCount = prefixCounts[to]![1] + (ops[to]!.kind !== 'del' ? 1 : 0) - nStart + 1
    hunks.push(`@@ -${oStart},${oCount} +${nStart},${nCount} @@`)
    for (let k = from; k <= to; k++) {
      const op = ops[k]!
      hunks.push(op.kind === 'equal' ? ` ${op.text}` : op.kind === 'del' ? `-${op.text}` : `+${op.text}`)
    }
  }
  return hunks.join('\n')
}
