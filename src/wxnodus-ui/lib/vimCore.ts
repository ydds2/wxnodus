// src/wxnodus-ui/lib/vimCore.ts — vim 模态编辑纯核心（波 3 ② 8→9）
// gemini hooks/vim.ts:88-170（状态机）+ vim-buffer-actions.ts:164（纯 reducer）对标直搬语义：
// 按键解释 = 纯函数（state, doc, key）→ (state, doc, 效果)——零副作用、天然可 undo。
// 范围（与 gemini 同档子集，诚实边界）：NORMAL/INSERT 两态；hjkl / w b e W B E / 0 $ ^ /
// gg G / f F t T / x X r ~ / dd cc yy D C Y / d c y+移动 / p P / u / `.` 重复 / 数字前缀。
// P3 增量（2026-08-18，audit §13.76）：VISUAL 字符/行选区（v/V + d/x/y/c/p/P 作用选区）——
// **六家皆无**（gemini vim.ts 1536 行 grep 零命中；codex vim.rs VimMode 仅 Normal/Insert :7-13，
// 有括号栈文本对象 :229-264 但无 VISUAL）——wxnodus 独有。
// P3 评估轮增量：文本对象 di(/da(/ciw/yi{/vi( 等（codex 括号栈深度计数对标，i/a 两键状态机）。
// P3 评估轮增量二：/ ? 增量搜索（回绕/Backspace/Enter/Esc——findNextMatch）+ Ctrl-R redo
// （<redo> 信号 + vimHistoryRedo）——均已实现（头注释旧「仍无」与实现矛盾，2026-08-19 修正）。

export type VimMode = 'normal' | 'insert' | 'visual'

export interface VimCoreState {
  mode: VimMode
  /** 数字前缀（×10 累积，gemini :136-137） */
  count: number
  /** 待执行操作符（d/c/y+移动 gemini :618-657；f/F/t/T 预读挂起同槽复用） */
  pendingOp: null | 'd' | 'c' | 'y' | 'f' | 'F' | 't' | 'T'
  /** 上一次可重复命令（`.` 重复，gemini :1410）——多键序列（含 count 位） */
  lastCommand: { keys: string[]; count: number } | null
  /** 上次 Esc 时间（双击 Esc 清空检测 500ms，gemini :686-700） */
  lastEscTs: number
  /** VISUAL 选区锚点（进入 visual 时的光标；-1=无选区） */
  visualAnchor: number
  /** 选区种类：char（v）｜line（V） */
  visualKind: 'char' | 'line' | null
  /** 文本对象前缀挂起（di(/da"/ciw/yi{ 的 i/a——codex vim.rs:229-264 括号栈对标，P3 评估轮） */
  pendingIo: null | 'i' | 'a'
  /** / 或 ? 增量搜索挂起（query 累积；anchor=进入搜索时的光标——Esc 取消还原，Enter 确认） */
  search: { query: string; dir: 1 | -1; anchor: number } | null
}

/** 文档模型：输入框文本 + 光标（char offset，0..text.length；\n 合法——多行输入） */
export interface VimDoc {
  text: string
  cursor: number
}

export interface VimOutcome {
  state: VimCoreState
  doc: VimDoc
  /** 本次进寄存器的文本（p/P 数据源）；null=无 */
  yanked: string | null
  /** 产生可撤销编辑（hook 据此压 undo 栈） */
  undoable: boolean
  /** 请求撤销（u——undo 栈由 hook 管理，核心只发信号） */
  undo: boolean
  /** 请求重做（Ctrl-R——redo 栈由 hook 管理，核心只发信号） */
  redo: boolean
  /** 进入 insert 模式（i/a/o/O/I/A/c 类命令） */
  enteredInsert: boolean
  /** 双击 Esc 清空（正常模式连按两次） */
  cleared: boolean
  /** false=本键不属 vim（insert 模式普通字符——放行给正常输入路径） */
  consumed: boolean
}

export const initialVimState = (): VimCoreState => ({
  mode: 'insert',
  count: 0,
  pendingOp: null,
  lastCommand: null,
  lastEscTs: 0,
  visualAnchor: -1,
  visualKind: null,
  pendingIo: null,
  search: null,
})

const DOUBLE_ESC_MS = 500

// ── 行/列换算（多行输入；\n 分行）────────────────────────────
const lineStarts = (text: string): number[] => {
  const out = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) out.push(i + 1)
  }
  return out
}

export const cursorRow = (text: string, cursor: number): number => {
  let row = 0
  for (let i = 0; i < cursor; i++) {
    if (text.charCodeAt(i) === 10) row++
  }
  return row
}

const rowStart = (text: string, row: number): number => {
  let r = 0
  for (let i = 0; i < text.length; i++) {
    if (r === row) return i
    if (text.charCodeAt(i) === 10) r++
  }
  return text.length
}

const lineLength = (text: string, rowStartIdx: number): number => {
  const nl = text.indexOf('\n', rowStartIdx)
  return nl < 0 ? text.length - rowStartIdx : nl - rowStartIdx
}

const colOf = (text: string, cursor: number): number => {
  const rs = rowStart(text, cursorRow(text, cursor))
  return cursor - rs
}

const clampCursor = (text: string, cursor: number): number =>
  Math.max(0, Math.min(text.length, cursor))

// ── 移动（返回新 cursor；count 语义：h/l 步进 count，j/k 行内 clamp）──
const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch)
const isBigWordChar = (ch: string): boolean => !/\s/.test(ch)

/** 向前跳过同词字符（w/b/e 用 isWordChar；W/B/E 用 isBigWordChar） */
const skipForward = (text: string, from: number, wordFn: (ch: string) => boolean): number => {
  let i = clampCursor(text, from)
  const n = text.length
  // 跳过空白（w 语义：先跨当前词内，再空白，再到下词首）
  while (i < n && !wordFn(text[i]!)) i++
  while (i < n && wordFn(text[i]!)) i++
  while (i < n && !wordFn(text[i]!)) i++
  return i
}

const skipBack = (text: string, from: number, wordFn: (ch: string) => boolean): number => {
  let i = clampCursor(text, from)
  while (i > 0 && !wordFn(text[i - 1]!)) i--
  while (i > 0 && wordFn(text[i - 1]!)) i--
  return i
}

/** e：词尾（含光标处词） */
const wordEnd = (text: string, from: number, wordFn: (ch: string) => boolean): number => {
  let i = clampCursor(text, from)
  const n = text.length
  while (i < n && !wordFn(text[i]!)) i++
  while (i < n && wordFn(text[i]!)) i++
  return Math.max(from, i - 1)
}

const motionWordForward = (text: string, cursor: number, big: boolean, count: number): number => {
  const fn = big ? isBigWordChar : isWordChar
  let c = cursor
  for (let k = 0; k < count; k++) c = skipForward(text, c, fn)
  return clampCursor(text, c)
}

const motionWordBack = (text: string, cursor: number, big: boolean, count: number): number => {
  const fn = big ? isBigWordChar : isWordChar
  let c = cursor
  for (let k = 0; k < count; k++) c = skipBack(text, c, fn)
  return clampCursor(text, c)
}

const motionWordEnd = (text: string, cursor: number, big: boolean, count: number): number => {
  const fn = big ? isBigWordChar : isWordChar
  let c = cursor
  for (let k = 0; k < count; k++) c = wordEnd(text, c, fn)
  return clampCursor(text, c)
}

const motionLineDown = (text: string, cursor: number, count: number): number => {
  const row = Math.min(cursorRow(text, cursor) + count, lineStarts(text).length - 1)
  const rs = rowStart(text, row)
  return clampCursor(text, rs + Math.min(colOf(text, cursor), lineLength(text, rs)))
}

const motionLineUp = (text: string, cursor: number, count: number): number => {
  const row = Math.max(cursorRow(text, cursor) - count, 0)
  const rs = rowStart(text, row)
  return clampCursor(text, rs + Math.min(colOf(text, cursor), lineLength(text, rs)))
}

/** f/F/t/T：行内查找字符（不含自身；找不到原地不动——vim 同款） */
const motionFind = (text: string, cursor: number, ch: string, kind: 'f' | 'F' | 't' | 'T', count: number): number => {
  const row = cursorRow(text, cursor)
  const rs = rowStart(text, row)
  const line = text.slice(rs, rs + lineLength(text, rs))
  const base = cursor - rs
  let pos = kind === 'f' || kind === 't' ? base + 1 : base - 1
  let found = -1
  for (let k = 0; k < count; k++) {
    found = -1
    if (kind === 'f' || kind === 't') {
      for (let i = pos; i < line.length; i++) {
        if (line[i] === ch) { found = i; break }
      }
    } else {
      for (let i = pos; i >= 0; i--) {
        if (line[i] === ch) { found = i; break }
      }
    }
    if (found < 0) break
    pos = kind === 'f' || kind === 't' ? found + 1 : found - 1
  }
  if (found < 0) return cursor
  const landed = kind === 't' ? found - 1 : kind === 'T' ? found + 1 : found
  return clampCursor(text, rs + Math.max(0, landed))
}

const BRACKET_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' }
const CLOSERS = new Set(Object.values(BRACKET_PAIRS))

/** 文本对象区间（i=内 / a=含定界符）——codex vim.rs:229-264 括号栈对标（配对深度计数）
 *  括号 ()[]{ }<>（开/闭括号皆可作对象字符）、引号 '"、词 w/W。找不到 → null */
export const textObjectRange = (text: string, cursor: number, io: 'i' | 'a', ch: string): [number, number] | null => {
  const c = clampCursor(text, cursor)
  const n = text.length
  if (ch === 'w' || ch === 'W') {
    const fn = ch === 'W' ? isBigWordChar : isWordChar
    // 光标在空白上：iw/aw 选空白串本身（vim 语义——空白即"词"），不跳下一词
    if (/\s/.test(text[c] ?? '')) {
      let s = c
      while (s > 0 && /\s/.test(text[s - 1]!)) s--
      let e = c
      while (e < n && /\s/.test(text[e]!)) e++
      return [s, e]
    }
    let s = c
    while (s > 0 && fn(text[s - 1]!)) s--
    let e = c
    while (e < n && fn(text[e]!)) e++
    if (s === e) {
      // 光标不在词字符上（标点等）：向右取下一词
      let i = c
      while (i < n && !fn(text[i]!)) i++
      if (i >= n) return null
      s = i; e = i
      while (e < n && fn(text[e]!)) e++
    }
    if (io === 'a') {
      let ee = e
      while (ee < n && /\s/.test(text[ee]!)) ee++
      e = ee > e ? ee : e // aw：词 + 尾随空白；无空白退化为 iw
    }
    return [s, e]
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    const row = cursorRow(text, c)
    const rs = rowStart(text, row)
    const lineEnd = rs + lineLength(text, rs)
    const open = text.indexOf(ch, rs)
    if (open < 0 || open > lineEnd) return null
    const close = text.indexOf(ch, open + 1)
    if (close < 0 || close > lineEnd) return null
    if (c < open || c > close) return null
    return io === 'i' ? [open + 1, close] : [open, close + 1]
  }
  if (ch in BRACKET_PAIRS) {
    // 开括号对象：先看光标正下方，再向左扫找最近未闭合的开括号（深度=右侧已见闭括号数）
    let openIdx = text[c] === ch ? c : -1
    if (openIdx < 0) {
      let depth = 0
      for (let i = c - 1; i >= 0; i--) {
        const t = text[i]!
        if (t === BRACKET_PAIRS[ch]) depth++
        else if (t === ch) {
          if (depth === 0) { openIdx = i; break }
          depth--
        }
      }
    }
    if (openIdx < 0) return null
    let d = 0
    for (let i = openIdx + 1; i < n; i++) {
      const t = text[i]!
      if (t === ch) d++
      else if (t === BRACKET_PAIRS[ch]) {
        if (d === 0) return io === 'i' ? [openIdx + 1, i] : [openIdx, i + 1]
        d--
      }
    }
    return null
  }
  if (CLOSERS.has(ch)) {
    // 闭括号对象：向左找对应开括号（深度计数）
    let d = 0
    let openIdx = -1
    for (let i = c - 1; i >= 0; i--) {
      const t = text[i]!
      if (t === ch) d++
      else if (t in BRACKET_PAIRS && BRACKET_PAIRS[t] === ch) {
        if (d === 0) { openIdx = i; break }
        d--
      }
    }
    if (openIdx < 0) return null
    let depth = 0
    for (let i = openIdx + 1; i < n; i++) {
      const t = text[i]!
      if (t in BRACKET_PAIRS && BRACKET_PAIRS[t] === ch) depth++
      else if (t === ch) {
        if (depth === 0) return io === 'i' ? [openIdx + 1, i] : [openIdx, i + 1]
        depth--
      }
    }
    return null
  }
  return null
}

/** / 增量搜索下一匹配（dir=1 向后 / -1 向前；回绕；无匹配 -1）——六家对标（codex history_search 同源语义） */
export const findNextMatch = (text: string, from: number, query: string, dir: 1 | -1): number => {
  if (!query) return -1
  if (dir === 1) {
    const after = text.indexOf(query, from + 1)
    if (after >= 0) return after
    return text.indexOf(query, 0)
  }
  const before = from - 1 >= 0 ? text.lastIndexOf(query, from - 1) : -1
  if (before >= 0) return before
  return text.lastIndexOf(query)
}

/** vim undo/redo 历史纯函数（栈上限 200；新编辑清 redo——vim 语义）——hook 层持有 */
export interface VimHistory { undo: VimDoc[]; redo: VimDoc[] }
export const initialVimHistory = (): VimHistory => ({ undo: [], redo: [] })
export const vimHistoryPush = (h: VimHistory, doc: VimDoc): VimHistory => ({
  undo: [...h.undo, doc].slice(-200),
  redo: [], // 新编辑清空 redo 分支（vim 语义）
})
export const vimHistoryUndo = (h: VimHistory, cur: VimDoc): { h: VimHistory; doc: VimDoc } | null => {
  const prev = h.undo[h.undo.length - 1]
  if (!prev) return null
  return { h: { undo: h.undo.slice(0, -1), redo: [...h.redo, cur].slice(-200) }, doc: prev }
}
export const vimHistoryRedo = (h: VimHistory, cur: VimDoc): { h: VimHistory; doc: VimDoc } | null => {
  const next = h.redo[h.redo.length - 1]
  if (!next) return null
  return { h: { undo: [...h.undo, cur].slice(-200), redo: h.redo.slice(0, -1) }, doc: next }
}

// ── 编辑（纯变换；yank 寄存器经 outcome 传出）──────────────────
interface Edit {
  text: string
  cursor: number
  yank: string | null
}const replaceRange = (doc: VimDoc, from: number, to: number, replacement: string, cursorAfter?: number): Edit => {
  const a = Math.min(from, to)
  const b = Math.max(from, to)
  const text = doc.text.slice(0, a) + replacement + doc.text.slice(b)
  return { text, cursor: clampCursor(text, cursorAfter ?? a), yank: doc.text.slice(a, b) }
}

/** 删除范围并压寄存器（d 操作符与 dd/D/x 共用） */
const deleteRange = (doc: VimDoc, from: number, to: number): Edit => replaceRange(doc, from, to, '')

const editDeleteChar = (doc: VimDoc, count: number): Edit => {
  const to = Math.min(doc.text.length, doc.cursor + count)
  if (to <= doc.cursor) return { text: doc.text, cursor: doc.cursor, yank: null }
  return deleteRange(doc, doc.cursor, to)
}

const editBackspaceChar = (doc: VimDoc, count: number): Edit => {
  const from = Math.max(0, doc.cursor - count)
  if (from >= doc.cursor) return { text: doc.text, cursor: doc.cursor, yank: null }
  const e = deleteRange(doc, from, doc.cursor)
  return { text: e.text, cursor: from, yank: e.yank }
}

const editReplaceChar = (doc: VimDoc, ch: string, count: number): Edit => {
  const to = Math.min(doc.text.length, doc.cursor + count)
  const rep = ch.repeat(Math.max(1, to - doc.cursor))
  return { text: doc.text.slice(0, doc.cursor) + rep + doc.text.slice(to), cursor: doc.cursor, yank: null }
}

const editToggleCase = (doc: VimDoc, count: number): Edit => {
  const to = Math.min(doc.text.length, doc.cursor + count)
  let changed = ''
  for (let i = doc.cursor; i < to; i++) {
    const ch = doc.text[i]!
    const lo = ch.toLowerCase()
    changed += ch === lo ? ch.toUpperCase() : lo
  }
  return { text: doc.text.slice(0, doc.cursor) + changed + doc.text.slice(to), cursor: Math.min(doc.text.length, to), yank: null }
}

/** 行操作区间（dd/cc/yy/D/C/Y——gemini :1290-1399） */
const lineRange = (doc: VimDoc, count: number): { from: number; to: number } => {
  const row = cursorRow(doc.text, doc.cursor)
  const rows = lineStarts(doc.text).length
  const endRow = Math.min(rows - 1, row + count - 1)
  const from = rowStart(doc.text, row)
  const toRs = rowStart(doc.text, endRow)
  const to = toRs + lineLength(doc.text, toRs) + (endRow < rows - 1 ? 1 : 0) // 含行尾 \n
  return { from, to }
}

const editDeleteLine = (doc: VimDoc, count: number): Edit => {
  const { from, to } = lineRange(doc, count)
  const e = deleteRange(doc, from, to)
  return { text: e.text, cursor: Math.min(from, e.text.length), yank: e.yank }
}

const editYankLine = (doc: VimDoc, count: number): Edit => {
  const { from, to } = lineRange(doc, count)
  return { text: doc.text, cursor: doc.cursor, yank: doc.text.slice(from, to) }
}

const editChangeLine = (doc: VimDoc): Edit => {
  // cc：清行内容但保留换行（vim 语义——行结构不塌缩，进入 insert 于空行）
  const row = cursorRow(doc.text, doc.cursor)
  const rs = rowStart(doc.text, row)
  const end = rs + lineLength(doc.text, rs)
  const e = deleteRange(doc, rs, end)
  return { text: e.text, cursor: rs, yank: e.yank }
}

const editChangeToEol = (doc: VimDoc): Edit => {
  const row = cursorRow(doc.text, doc.cursor)
  const rs = rowStart(doc.text, row)
  const end = rs + lineLength(doc.text, rs)
  return deleteRange(doc, doc.cursor, end)
}

const editDeleteToEol = (doc: VimDoc): Edit => editChangeToEol(doc)

const pasteAfter = (doc: VimDoc, register: string): Edit => {
  if (!register) return { text: doc.text, cursor: doc.cursor, yank: null }
  return { text: doc.text.slice(0, doc.cursor + 1) + register + doc.text.slice(doc.cursor + 1), cursor: doc.cursor + 1, yank: null }
}

const pasteBefore = (doc: VimDoc, register: string): Edit => {
  if (!register) return { text: doc.text, cursor: doc.cursor, yank: null }
  return { text: doc.text.slice(0, doc.cursor) + register + doc.text.slice(doc.cursor), cursor: doc.cursor, yank: null }
}

// ── 主解释器 ─────────────────────────────────────────────────
export function vimHandleKey(
  prev: VimCoreState,
  docIn: VimDoc,
  key: string,
  now: number,
  register: string,
): VimOutcome {
  const base = (over: Partial<VimOutcome> = {}): VimOutcome => ({
    state: prev,
    doc: docIn,
    yanked: null,
    undoable: false,
    undo: false,
    redo: false,
    enteredInsert: false,
    cleared: false,
    consumed: true,
    ...over,
  })
  const count = prev.count === 0 ? 1 : prev.count

  // ── INSERT 模式：Esc 回 normal（gemini :474-481），其余全放行 ──
  if (prev.mode === 'insert') {
    if (key === 'Escape' || key === '<esc>') {
      return base({ state: { ...prev, mode: 'normal', count: 0, lastEscTs: now } })
    }
    return base({ consumed: false })
  }

  // ── / 搜索挂起（六家对标：in-buffer 增量搜索；Esc 取消还原锚点、Enter 确认、Backspace 退格）──
  if (prev.search) {
    if (key === 'Escape' || key === '<esc>') {
      return base({ state: { ...prev, search: null, count: 0 }, doc: { text: docIn.text, cursor: prev.search.anchor } })
    }
    if (key === 'Enter') return base({ state: { ...prev, search: null, count: 0 } })
    if (key === 'Backspace') {
      const q = prev.search.query.slice(0, -1)
      const hit = q ? findNextMatch(docIn.text, prev.search.anchor, q, prev.search.dir) : -1
      return base({
        state: { ...prev, search: { ...prev.search, query: q } },
        doc: { text: docIn.text, cursor: hit >= 0 ? hit : prev.search.anchor },
      })
    }
    if (key.length === 1) {
      const q = prev.search.query + key
      const hit = findNextMatch(docIn.text, prev.search.anchor, q, prev.search.dir)
      return base({
        state: { ...prev, search: { ...prev.search, query: q } },
        doc: { text: docIn.text, cursor: hit >= 0 ? hit : docIn.cursor },
      })
    }
    return base({ state: { ...prev } }) // 其他键忽略（搜索挂起期只吃字符/退格/回车/Esc）
  }
  if (key === '/' || key === '?') {
    return base({
      state: { ...prev, search: { query: '', dir: key === '/' ? 1 : -1, anchor: docIn.cursor }, pendingOp: null, pendingIo: null, count: 0 },
    })
  }

  // ── NORMAL：数字前缀（0 不单独计——count=0 即 1；gemini :136-137 ×10 累积）──
  if (/^[1-9]$/.test(key)) {
    return base({ state: { ...prev, count: prev.count * 10 + Number(key) } })
  }
  if (key === '0' && prev.count > 0) {
    return base({ state: { ...prev, count: prev.count * 10 } })
  }

  // Esc：双击 500ms 内清空（gemini :686-700）——仅 normal；visual 的 Esc 由下方 VISUAL 块处理
  if (prev.mode === 'normal' && (key === 'Escape' || key === '<esc>')) {
    if (prev.lastEscTs > 0 && now - prev.lastEscTs <= DOUBLE_ESC_MS) {
      return base({
        state: { ...prev, count: 0, pendingOp: null, lastEscTs: 0 },
        doc: { text: '', cursor: 0 },
        cleared: true,
        undoable: true,
      })
    }
    return base({ state: { ...prev, count: 0, pendingOp: null, lastEscTs: now } })
  }

  const countKeys = count > 1 ? [String(count)] : []
  const applyEdit = (e: Edit, enterInsert = false, repeatable: string[] | null = null): VimOutcome =>
    base({
      state: {
        ...prev,
        count: 0,
        pendingOp: null,
        pendingIo: null,
        mode: enterInsert ? 'insert' : 'normal',
        lastCommand: repeatable ? { keys: [...countKeys, ...repeatable], count } : prev.lastCommand,
      },
      doc: { text: e.text, cursor: e.cursor },
      yanked: e.yank,
      undoable: e.text !== docIn.text || e.cursor !== docIn.cursor,
      enteredInsert: enterInsert,
    })

  const applyMotion = (newCursor: number): VimOutcome =>
    base({
      state: { ...prev, count: 0, pendingOp: null },
      doc: { text: docIn.text, cursor: newCursor },
      undoable: false,
    })

  // ── 移动（无操作符）──
  const motionKeys: Record<string, () => number> = {
    h: () => Math.max(0, docIn.cursor - count),
    l: () => Math.min(docIn.text.length, docIn.cursor + count),
    j: () => motionLineDown(docIn.text, docIn.cursor, count),
    k: () => motionLineUp(docIn.text, docIn.cursor, count),
    w: () => motionWordForward(docIn.text, docIn.cursor, false, count),
    b: () => motionWordBack(docIn.text, docIn.cursor, false, count),
    e: () => motionWordEnd(docIn.text, docIn.cursor, false, count),
    W: () => motionWordForward(docIn.text, docIn.cursor, true, count),
    B: () => motionWordBack(docIn.text, docIn.cursor, true, count),
    E: () => motionWordEnd(docIn.text, docIn.cursor, true, count),
    '0': () => rowStart(docIn.text, cursorRow(docIn.text, docIn.cursor)),
    $: () => {
      const row = cursorRow(docIn.text, docIn.cursor)
      const rs = rowStart(docIn.text, row)
      const len = lineLength(docIn.text, rs)
      return rs + Math.max(0, len - 1)
    },
    '^': () => {
      const rs = rowStart(docIn.text, cursorRow(docIn.text, docIn.cursor))
      const len = lineLength(docIn.text, rs)
      let off = 0
      while (off < len && /[ \t]/.test(docIn.text[rs + off]!)) off++
      return rs + (off < len ? off : Math.max(0, len - 1))
    },
    gg: () => 0,
    G: () => Math.max(0, docIn.text.length - 1),
    Enter: () => motionLineDown(docIn.text, docIn.cursor, count),
    Backspace: () => motionLineUp(docIn.text, docIn.cursor, count),
  }

  // f/F/t/T + 下一键字符：核心无法预读下一键——由 hook 分两步（pendingFind 状态）
  // gemini 同构（pendingFindOp :88-170）——这里以 `<find:ch>` 编码键接收
  if (/^<find:[^>]>$/.test(key)) {
    const ch = key.slice(6, -1)!
    const kind = prev.pendingOp as 'f' | 'F' | 't' | 'T' | null
    return kind === 'f' || kind === 'F' || kind === 't' || kind === 'T'
      ? applyMotion(motionFind(docIn.text, docIn.cursor, ch, kind, count))
      : base()
  }

  // ── VISUAL 模式（P3 增量：v=字符选区 / V=行选区；d/x/y/c/p/P 直接作用选区；
  //  移动扩展选区；Esc 回 normal——codex textarea/vim.rs 对标，gemini vim.ts 无此模式）──
  if (prev.mode === 'visual') {
    if (key === 'Escape' || key === '<esc>') {
      return base({ state: { ...prev, mode: 'normal', visualAnchor: -1, visualKind: null, count: 0 } })
    }
    if (/^[1-9]$/.test(key)) {
      return base({ state: { ...prev, count: prev.count * 10 + Number(key) } })
    }
    const anchor = prev.visualAnchor >= 0 ? prev.visualAnchor : docIn.cursor
    const selRange = (cur: number): [number, number] => {
      const a = Math.min(anchor, cur)
      const b = Math.max(anchor, cur)
      if (prev.visualKind === 'line') {
        const r1 = rowStart(docIn.text, cursorRow(docIn.text, a))
        const r2s = rowStart(docIn.text, cursorRow(docIn.text, b))
        const r2e = r2s + lineLength(docIn.text, r2s)
        return [r1, r2e + (r2e < docIn.text.length ? 1 : 0)]
      }
      return [a, Math.min(docIn.text.length, b + 1)]
    }
    const applySel = (kind: 'd' | 'y' | 'c'): VimOutcome => {
      const [from, to] = selRange(docIn.cursor)
      const e = kind === 'y'
        ? { text: docIn.text, cursor: from, yank: docIn.text.slice(from, to) }
        : deleteRange(docIn, from, to)
      const nextMode: VimMode = kind === 'c' ? 'insert' : 'normal'
      return base({
        state: { ...prev, mode: nextMode, count: 0, pendingOp: null, visualAnchor: -1, visualKind: null },
        doc: { text: e.text, cursor: from },
        yanked: e.yank,
        undoable: e.text !== docIn.text || from !== docIn.cursor,
        enteredInsert: kind === 'c',
      })
    }
    if (key === 'd' || key === 'x') return applySel('d')
    if (key === 'y') return applySel('y')
    if (key === 'c') return applySel('c')
    if (key === 'p' || key === 'P') {
      const [from, to] = selRange(docIn.cursor)
      if (!register) return base({ state: { ...prev, count: 0 } })
      const text = docIn.text.slice(0, from) + register + docIn.text.slice(to)
      return base({
        state: { ...prev, mode: 'normal', count: 0, visualAnchor: -1, visualKind: null },
        doc: { text, cursor: from },
        undoable: true,
      })
    }
    // 文本对象选区（vi(/va"/viw…）：i/a 前缀挂起，下一键求区间→选区直接覆盖对象
    if (key === 'i' || key === 'a') {
      return base({ state: { ...prev, pendingIo: key } })
    }
    if (prev.pendingIo) {
      const range = textObjectRange(docIn.text, docIn.cursor, prev.pendingIo, key)
      if (!range) return base({ state: { ...prev, pendingIo: null, count: 0 } })
      const [from, to] = range
      return base({
        state: { ...prev, pendingIo: null, visualAnchor: from, count: 0 },
        doc: { text: docIn.text, cursor: Math.max(from, Math.min(docIn.text.length, to - 1)) },
      })
    }
    // 移动键扩展选区：applyMotion 只动光标，state 展开保留 visualAnchor/visualKind（选区扩展语义）
    if (motionKeys[key]) return applyMotion(motionKeys[key]!())
    return base({ state: { ...prev } })
  }

  // ── 操作符挂起/行内双写（d/c/y；dd/cc/yy——双写判定必须先于挂起）──
  if (key === 'd' || key === 'c' || key === 'y') {
    if (prev.pendingOp === key) {
      if (key === 'd') return applyEdit(editDeleteLine(docIn, count), false, ['d', 'd'])
      if (key === 'c') return applyEdit(editChangeLine(docIn), true, ['c', 'c'])
      return applyEdit(editYankLine(docIn, count), false, ['y', 'y'])
    }
    return base({ state: { ...prev, pendingOp: key } })
  }

  // 操作符 + 文本对象（di( da" ciw yi{ …）——i/a 前缀挂起，下一键字符求区间（codex 括号栈对标）
  // 必须在运动键分派之前：w/e/b 等既是运动键也是对象字符（iw/aw）——挂起对象时按对象解释
  if (prev.pendingOp && (key === 'i' || key === 'a')) {
    return base({ state: { ...prev, pendingIo: key } })
  }
  if (prev.pendingOp && prev.pendingIo) {
    const range = textObjectRange(docIn.text, docIn.cursor, prev.pendingIo, key)
    if (!range) return base({ state: { ...prev, pendingOp: null, pendingIo: null, count: 0 } })
    const [from, to] = range
    if (prev.pendingOp === 'd') return applyEdit(deleteRange(docIn, from, to), false, ['d', prev.pendingIo, key])
    if (prev.pendingOp === 'c') return applyEdit(deleteRange(docIn, from, to), true, ['c', prev.pendingIo, key])
    return applyEdit({ text: docIn.text, cursor: docIn.cursor, yank: docIn.text.slice(from, to) }, false, ['y', prev.pendingIo, key])
  }

  // 操作符 + 移动（dw/cw/yw/d$/d0/dG…）：移动键复用 motionKeys 计算端点
  if (prev.pendingOp && motionKeys[key]) {
    const to = motionKeys[key]!()
    const from = docIn.cursor
    const a = Math.min(from, to)
    const b = Math.max(from, to)
    // vim 含式语义：l/$ 含目标字符、e/E 含词尾字符；w/W 排他（到下一词首，不含）
    const inclRight = key === 'l' || key === '$' || key === 'e' || key === 'E'
    const end = inclRight && b < docIn.text.length ? b + 1 : b
    if (prev.pendingOp === 'd') return applyEdit(deleteRange(docIn, a, end), false, ['d', key])
    if (prev.pendingOp === 'c') return applyEdit(deleteRange(docIn, a, end), true, ['c', key])
    return applyEdit({ text: docIn.text, cursor: docIn.cursor, yank: docIn.text.slice(a, end) }, false, ['y', key])
  }
  // 操作符 + 文本对象（di( da" ciw yi{ …）——i/a 前缀挂起，下一键字符求区间（codex 括号栈对标）
  if (prev.pendingOp && (key === 'i' || key === 'a')) {
    return base({ state: { ...prev, pendingIo: key } })
  }
  if (prev.pendingOp && prev.pendingIo) {
    const range = textObjectRange(docIn.text, docIn.cursor, prev.pendingIo, key)
    if (!range) return base({ state: { ...prev, pendingOp: null, pendingIo: null, count: 0 } })
    const [from, to] = range
    if (prev.pendingOp === 'd') return applyEdit(deleteRange(docIn, from, to), false, ['d', prev.pendingIo, key])
    if (prev.pendingOp === 'c') return applyEdit(deleteRange(docIn, from, to), true, ['c', prev.pendingIo, key])
    return applyEdit({ text: docIn.text, cursor: docIn.cursor, yank: docIn.text.slice(from, to) }, false, ['y', prev.pendingIo, key])
  }
  if (prev.pendingOp) {
    // 操作符 + 未知键：取消操作符（gemini 同款——不悬挂）
    return base({ state: { ...prev, pendingOp: null, pendingIo: null, count: 0 } })
  }

  // ── 纯移动 ──
  if (motionKeys[key]) return applyMotion(motionKeys[key]!())
  // r 预读（hook 编 <replace:ch>）：替换 count 字符，光标不动
  const rm = /^<replace:(.)>$/.exec(key)
  if (rm) return applyEdit(editReplaceChar(docIn, rm[1]!, count), false, ['<replace:' + rm[1] + '>'])

  // ── 单键编辑 ──
  switch (key) {
    case 'x': return applyEdit(editDeleteChar(docIn, count), false, ['x'])
    case 'X': return applyEdit(editBackspaceChar(docIn, count), false, ['X'])
    case '~': return applyEdit(editToggleCase(docIn, count), false, ['~'])
    case 'D': return applyEdit(editDeleteToEol(docIn), false, ['D'])
    case 'C': return applyEdit(editChangeToEol(docIn), true, ['C'])
    case 'Y': return applyEdit(editYankLine(docIn, count), false, ['Y'])
    case 'p': return applyEdit(pasteAfter(docIn, register), false, ['p'])
    case 'P': return applyEdit(pasteBefore(docIn, register), false, ['P'])
    case 'u': return base({ state: { ...prev, count: 0, pendingOp: null }, undo: true })
    case '<redo>': return base({ state: { ...prev, count: 0, pendingOp: null }, redo: true })
    case 'v': return base({ state: { ...prev, mode: 'visual', count: 0, pendingOp: null, visualAnchor: docIn.cursor, visualKind: 'char' } })
    case 'V': return base({ state: { ...prev, mode: 'visual', count: 0, pendingOp: null, visualAnchor: docIn.cursor, visualKind: 'line' } })
    case 'i': return base({ state: { ...prev, mode: 'insert', count: 0, pendingOp: null }, enteredInsert: true })
    case 'a': return base({
      state: { ...prev, mode: 'insert', count: 0, pendingOp: null },
      doc: { text: docIn.text, cursor: Math.min(docIn.text.length, docIn.cursor + 1) },
      enteredInsert: true,
    })
    case 'I': {
      // vim I = 行首非空字符处插入（同 ^ 语义）
      const rs = rowStart(docIn.text, cursorRow(docIn.text, docIn.cursor))
      const len = lineLength(docIn.text, rs)
      let off = 0
      while (off < len && /[ \t]/.test(docIn.text[rs + off]!)) off++
      return base({
        state: { ...prev, mode: 'insert', count: 0, pendingOp: null },
        doc: { text: docIn.text, cursor: rs + (off < len ? off : Math.max(0, len - 1)) },
        enteredInsert: true,
      })
    }
    case 'A': return base({
      state: { ...prev, mode: 'insert', count: 0, pendingOp: null },
      doc: {
        text: docIn.text,
        cursor: (() => {
          const rs = rowStart(docIn.text, cursorRow(docIn.text, docIn.cursor))
          return rs + lineLength(docIn.text, rs)
        })(),
      },
      enteredInsert: true,
    })
    case 'o': {
      const rs = rowStart(docIn.text, cursorRow(docIn.text, docIn.cursor))
      const at = rs + lineLength(docIn.text, rs)
      const text = docIn.text.slice(0, at) + '\n' + docIn.text.slice(at)
      return base({
        state: { ...prev, mode: 'insert', count: 0, pendingOp: null },
        doc: { text, cursor: Math.min(text.length, at + 1) },
        undoable: true,
        enteredInsert: true,
      })
    }
    case 'O': {
      const at = rowStart(docIn.text, cursorRow(docIn.text, docIn.cursor))
      const text = docIn.text.slice(0, at) + '\n' + docIn.text.slice(at)
      return base({
        state: { ...prev, mode: 'insert', count: 0, pendingOp: null },
        doc: { text, cursor: at },
        undoable: true,
        enteredInsert: true,
      })
    }
    case '.': {
      // 重复上次命令（多键序列逐个回放；不递归记录——lastCommand 置 null 回放后再恢复）
      if (!prev.lastCommand) return base({ state: { ...prev, count: 0 } })
      let st: VimCoreState = { ...prev, count: 0, pendingOp: null, lastCommand: null }
      let doc = docIn
      let reg = register
      let yanked: string | null = null
      for (const k of prev.lastCommand.keys) {
        const r = vimHandleKey(st, doc, k, now, reg)
        st = r.state
        doc = r.doc
        if (r.yanked) { yanked = r.yanked; reg = r.yanked }
        if (r.cleared) break
      }
      return base({
        state: { ...st, count: 0, pendingOp: null, lastCommand: prev.lastCommand },
        doc,
        yanked: yanked ?? null,
        undoable: doc.text !== docIn.text || doc.cursor !== docIn.cursor,
      })
    }
    default: {
      // f/F/t/T 挂起预读（下一键由 hook 编 <find:ch> 传入）
      if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
        return base({ state: { ...prev, pendingOp: key } })
      }
      // 未识别键：保留状态（vim 同款——normal 模式未知键无动作）
      return base({ state: { ...prev } })
    }
  }
}
