import type { InputEvent, Key } from '@wxnodus/ink'
import * as Ink from '@wxnodus/ink'
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'

import { setInputSelection } from '../runtime/selectionStore.js'
import { readClipboardText, writeClipboardText } from '../lib/clipboard.js'
import { highlightInputAnsi } from '../lib/inputHighlight.js'
import { resolveEditorCommand, runExternalEditor } from '../lib/editorLaunch.js'
import { initialVimState, initialVimHistory, vimHandleKey, vimHistoryPush, vimHistoryUndo, vimHistoryRedo, type VimHistory, type VimMode } from '../lib/vimCore.js'
import { cursorLayout, offsetFromPosition } from '../lib/inputMetrics.js'
import {
  DEFAULT_VOICE_RECORD_KEY,
  isActionMod,
  isMac,
  isMacActionFallback,
  isVoiceToggleKey,
  type ParsedVoiceRecordKey
} from '../lib/platform.js'
import { isTermuxTuiMode } from '../lib/termux.js'

type InkExt = typeof Ink & {
  stringWidth: (s: string) => number
  useCursorAdvance: () => (dx: number, dy?: number) => void
  useDeclaredCursor: (a: { line: number; column: number; active: boolean }) => (el: any) => void
  useStdout: () => { stdout?: NodeJS.WriteStream }
  useTerminalFocus: () => boolean
}

const ink = Ink as unknown as InkExt
const { Box, Text, useStdin, useInput, useStdout, stringWidth, useCursorAdvance, useDeclaredCursor, useTerminalFocus } = ink

const ESC = '\x1b'
const INV = `${ESC}[7m`
const INV_OFF = `${ESC}[27m`
const DIM = `${ESC}[2m`
const DIM_OFF = `${ESC}[22m`
const FWD_DEL_RE = new RegExp(`${ESC}\\[3(?:[~$^]|;)`)
const PRINTABLE = /^[ -~\u00a0-\uffff]+$/
const BRACKET_PASTE = new RegExp(`${ESC}?\\[20[01]~`, 'g')
const FRAME_BATCH_MS = 16
const MULTI_CLICK_MS = 500
type MinimalEnv = Record<string, string | undefined>

// ── A19：双击选词/三击选行（输入框字符串版——参考 ink 选区同款语义）──
// 词字符：字母/数字/下划线/斜杠/点/连字符/加号/波浪号/反斜杠（iTerm2 默认词字符）
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

const charClass = (ch: string | undefined): number => {
  if (ch === undefined || ch === ' ' || ch === '\t' || ch === '\n') {
    return 0
  }

  return WORD_CHAR.test(ch) ? 1 : 2
}

/** 双击词边界：向两侧扩展同 class 连续段（词=1/标点=2；空白不扩展）。 */
export const wordBoundsAt = (value: string, offset: number): { end: number; start: number } => {
  const pos = Math.max(0, Math.min(value.length, offset))
  const cls = charClass(value[pos])

  if (cls === 0) {
    return { start: pos, end: pos }
  }

  let start = pos
  let end = pos

  while (start > 0 && charClass(value[start - 1]) === cls) start--
  while (end < value.length && charClass(value[end]) === cls) end++

  return { start, end }
}

/** 三击行边界：offset 所在的 \n 逻辑行。 */
export const lineBoundsAt = (value: string, offset: number): { end: number; start: number } => {
  const pos = Math.max(0, Math.min(value.length, offset))
  const start = value.lastIndexOf('\n', pos - 1) + 1
  const end = value.indexOf('\n', pos)

  return { start, end: end === -1 ? value.length : end }
}

const invert = (s: string) => INV + s + INV_OFF
const dim = (s: string) => DIM + s + DIM_OFF

let _seg: Intl.Segmenter | null = null
const seg = () => (_seg ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }))
const STOP_CACHE_MAX = 32
const stopCache = new Map<string, number[]>()

function graphemeStops(s: string) {
  const hit = stopCache.get(s)

  if (hit) {
    return hit
  }

  const stops = [0]

  for (const { index } of seg().segment(s)) {
    if (index > 0) {
      stops.push(index)
    }
  }

  if (stops.at(-1) !== s.length) {
    stops.push(s.length)
  }

  stopCache.set(s, stops)

  if (stopCache.size > STOP_CACHE_MAX) {
    const oldest = stopCache.keys().next().value

    if (oldest !== undefined) {
      stopCache.delete(oldest)
    }
  }

  return stops
}

function snapPos(s: string, p: number) {
  const pos = Math.max(0, Math.min(p, s.length))
  let last = 0

  for (const stop of graphemeStops(s)) {
    if (stop > pos) {
      break
    }

    last = stop
  }

  return last
}

export interface TextInsertResult {
  cursor: number
  value: string
}

export function applyPrintableInsert(
  value: string,
  cursor: number,
  text: string,
  range?: { end: number; start: number } | null
): null | TextInsertResult {
  if (!PRINTABLE.test(text)) {
    return null
  }

  if (range) {
    return {
      cursor: range.start + text.length,
      value: value.slice(0, range.start) + text + value.slice(range.end)
    }
  }

  return {
    cursor: cursor + text.length,
    value: value.slice(0, cursor) + text + value.slice(cursor)
  }
}

export const shouldRouteMultiCharInputAsPaste = (text: string): boolean => text.includes('\n')

export function shouldPreserveCtrlJNewline(env: MinimalEnv = process.env): boolean {
  if (env.WT_SESSION) {
    return true
  }

  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
    return true
  }

  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) {
    return true
  }

  if ((env.TERM ?? '').toLowerCase() === 'xterm-ghostty') {
    return true
  }

  if ((env.TERM_PROGRAM ?? '').toLowerCase() === 'ghostty') {
    return true
  }

  return (env.WSL_DISTRO_NAME ?? '').toLowerCase().includes('microsoft')
}

function prevPos(s: string, p: number) {
  const pos = snapPos(s, p)
  let prev = 0

  for (const stop of graphemeStops(s)) {
    if (stop >= pos) {
      return prev
    }

    prev = stop
  }

  return prev
}

function nextPos(s: string, p: number) {
  const pos = snapPos(s, p)

  for (const stop of graphemeStops(s)) {
    if (stop > pos) {
      return stop
    }
  }

  return s.length
}

function wordLeft(s: string, p: number) {
  let i = snapPos(s, p) - 1

  while (i > 0 && /\s/.test(s[i]!)) {
    i--
  }

  while (i > 0 && !/\s/.test(s[i - 1]!)) {
    i--
  }

  return Math.max(0, i)
}

function wordRight(s: string, p: number) {
  let i = snapPos(s, p)

  while (i < s.length && !/\s/.test(s[i]!)) {
    i++
  }

  while (i < s.length && /\s/.test(s[i]!)) {
    i++
  }

  return i
}

/**
 * Move cursor one logical line up or down inside `s` while preserving the
 * column offset from the current line's start. Returns `null` when the cursor
 * is already on the first line (up) or last line (down) — callers use that
 * signal to fall through to history cycling instead of eating the arrow key.
 */
export function lineNav(s: string, p: number, dir: -1 | 1): null | number {
  const pos = snapPos(s, p)
  const curStart = s.lastIndexOf('\n', pos - 1) + 1
  const col = pos - curStart

  if (dir < 0) {
    if (curStart === 0) {
      return null
    }

    const prevStart = s.lastIndexOf('\n', curStart - 2) + 1

    return snapPos(s, Math.min(prevStart + col, curStart - 1))
  }

  const nextBreak = s.indexOf('\n', pos)

  if (nextBreak < 0) {
    return null
  }

  const nextEnd = s.indexOf('\n', nextBreak + 1)
  const lineEnd = nextEnd < 0 ? s.length : nextEnd

  return snapPos(s, Math.min(nextBreak + 1 + col, lineEnd))
}

export { offsetFromPosition }

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/

/**
 * Pure shape-only precondition for the fast-echo append path.
 *
 * The fast-echo path bypasses Ink's renderer and writes text directly to
 * stdout, so the stored value, the rendered terminal cells, and the cursor
 * column must all stay in sync without any layout work. We only allow it
 * when the inserted text is pure printable ASCII so that:
 *
 *   - `text.length` matches the number of grapheme clusters (no combining
 *     marks, no surrogate pairs, no precomposed CJK / Latin-Extended
 *     letters that an IME might still be holding open as a composition),
 *   - terminal width is exactly 1 cell per character (no East-Asian wide,
 *     no zero-width, no ambiguous-width fonts),
 *   - input methods (Vietnamese Telex, IME, dead-keys) cannot leak
 *     intermediate composition bytes through the bypass before the final
 *     commit arrives — those always go through the normal Ink render path
 *     and stay layout-accurate (closes #5221, #7443, #17602/#17603).
 *
 * We deliberately do NOT just check `stringWidth(text) === text.length`:
 * Vietnamese precomposed letters like "ề" (U+1EC1) report width 1 and
 * length 1 but are still produced by IME compositions and must not be
 * fast-echoed.
 */
export function canFastAppendShape(
  current: string,
  cursor: number,
  text: string,
  columns: number,
  currentLineWidth: number
): boolean {
  if (cursor !== current.length) {
    return false
  }

  if (current.length === 0) {
    return false
  }

  if (current.includes('\n')) {
    return false
  }

  if (!ASCII_PRINTABLE_RE.test(text)) {
    return false
  }

  return currentLineWidth + text.length < Math.max(1, columns)
}

/**
 * Pure shape-only precondition for the fast-echo backspace path.
 *
 * Same reasoning as canFastAppendShape — only allow the direct
 * "\b \b" stdout shortcut when the deleted grapheme is pure printable
 * ASCII. Anything else (combining marks, IME compositions, wide chars,
 * tabs, ANSI fragments) goes through the normal render path so Ink can
 * recompute cell widths.
 *
 * When `columns` is supplied, ALSO rejects when the physical cursor
 * sits at visual column 0 — i.e., right after a soft-wrap boundary.
 * The "\b \b" sequence cannot move the cursor onto the previous visual
 * row (terminals don't back-step across line wraps), so the physical
 * cursor would stay put while the logical caret moves to the end of
 * the previous visual line, desyncing both Ink's `displayCursor` model
 * and the user-visible position.
 *
 * When `columns` is OMITTED, the wrap-boundary check is skipped
 * entirely and the function reverts to the legacy non-wrap-aware
 * contract — values like `'hello '` will return `true` even though
 * they would be unsafe at a width of 6. Production callers (the
 * composer's `canFastBackspace` helper) always pass `columns`;
 * `columns` is optional only so unit tests of the pre-wrap shape
 * contract can keep calling the helper without threading width
 * through. Do NOT omit it from any new caller that relies on the
 * wrap-boundary protection.
 */
export function canFastBackspaceShape(current: string, cursor: number, columns?: number): boolean {
  if (cursor !== current.length) {
    return false
  }

  if (cursor <= 0) {
    return false
  }

  if (current.includes('\n')) {
    return false
  }

  // If we know the wrap width, reject at the soft-wrap boundary: the
  // caret's physical column would be at (or past) the terminal's right
  // edge, so the terminal has already auto-wrapped to the next row.
  // "\b \b" can't represent the physical move back across that wrap.
  //
  // We check `column === 0` for the "wrap-ansi broke onto a new line"
  // case AND `column >= columns` for the "exact-fill, terminal auto-wraps"
  // case. Both manifest as the same physical state (cursor parked at
  // col 0 of the next row) but cursorLayout reports them differently
  // because it now mirrors wrap-ansi's break points exactly (see the
  // cursor-drift-multiline fix in lib/inputMetrics.ts).
  if (columns !== undefined) {
    const layout = cursorLayout(current, cursor, columns)

    if (layout.column === 0 || layout.column >= columns) {
      return false
    }
  }

  const removed = current.slice(prevPos(current, cursor), cursor)

  return ASCII_PRINTABLE_RE.test(removed)
}

export function supportsFastEchoTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  // Terminal.app still shows paint/cursor artifacts under the fast-echo
  // bypass path. Fall back to the normal Ink render path there.
  if ((env.TERM_PROGRAM ?? '').trim() === 'Apple_Terminal') {
    return false
  }

  // Termux terminals are especially sensitive to bypass-path cursor drift and
  // stale paints at soft-wrap boundaries on tall/narrow viewports. Keep this
  // off by default in Termux mode; allow explicit opt-in for local debugging.
  if (isTermuxTuiMode(env)) {
    const override = String(env.WXNODUS_TUI_TERMUX_FAST_ECHO ?? '').trim().toLowerCase()

    if (override) {
      return /^(?:1|true|yes|on)$/i.test(override)
    }

    return false
  }

  // A14 修复：tmux 会话（TERM=tmux*）禁用快速回显——bypass 路径在 tmux 的
  // 分隔窗格/滚动区边界存在光标漂移（参考同款保护）
  if (/^tmux(?:-.+)?$/i.test(String(env.TERM ?? '').trim()) || (env.TMUX ?? '').length > 0) {
    return false
  }

  return true
}

function renderWithCursor(value: string, cursor: number) {
  const pos = Math.max(0, Math.min(cursor, value.length))

  let out = '',
    done = false

  for (const { segment, index } of seg().segment(value)) {
    if (!done && index >= pos) {
      out += invert(index === pos && segment !== '\n' ? segment : ' ')
      done = true

      if (index === pos && segment !== '\n') {
        continue
      }
    }

    out += segment
  }

  return done ? out : out + invert(' ')
}

function renderWithSelection(value: string, start: number, end: number) {
  if (start >= end) {
    return value
  }

  return value.slice(0, start) + invert(value.slice(start, end) || ' ') + value.slice(end)
}

function useFwdDelete(active: boolean) {
  const ref = useRef(false)
  const { inputEmitter: ee } = useStdin()

  useEffect(() => {
    if (!active) {
      return
    }

    const h = (d: string) => {
      ref.current = FWD_DEL_RE.test(d)
    }

    ee.prependListener('input', h)

    return () => {
      ee.removeListener('input', h)
    }
  }, [active, ee])

  return ref
}

type PasteResult = { cursor: number; value: string } | null

const isPasteResultPromise = (
  value: PasteResult | Promise<PasteResult> | null | undefined
): value is Promise<PasteResult> => !!value && typeof (value as PromiseLike<PasteResult>).then === 'function'

export function TextInput({
  columns = 80,
  value,
  onChange,
  onPaste,
  onSubmit,
  mask,
  mouseApiRef,
  voiceRecordKey = DEFAULT_VOICE_RECORD_KEY,
  placeholder = '',
  focus = true,
  vimEnabled = false
}: TextInputProps) {
  const [cur, setCur] = useState(value.length)
  const [sel, setSel] = useState<null | { end: number; start: number }>(null)
  const fwdDel = useFwdDelete(focus)
  const termFocus = useTerminalFocus()
  const { stdout } = useStdout()
  const noteCursorAdvance = useCursorAdvance()

  const curRef = useRef(cur)
  const selRef = useRef<null | { end: number; start: number }>(null)
  const vRef = useRef(value)
  const self = useRef(false)
  const keyBurstTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editVersionRef = useRef(0)
  const parentChangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingParentValue = useRef<string | null>(null)
  const localRenderTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lineWidthRef = useRef(stringWidth(value.includes('\n') ? value.slice(value.lastIndexOf('\n') + 1) : value))
  const mouseAnchorRef = useRef<null | number>(null)
  const lastClickRef = useRef<{ at: number; count: number; offset: number }>({ at: 0, count: 0, offset: -1 })
  // A19：最近一次 press 是否触发多击（选词/选行/全选）——release 的
  // onClick 据此保留高亮，不执行"点击定位+清选区"。
  const lastMultiClickRef = useRef(false)
  const undo = useRef<{ cursor: number; value: string }[]>([])
  const redo = useRef<{ cursor: number; value: string }[]>([])
  // 波 3 ②：vim 模态状态（纯 reducer 解释器 + 寄存器 + 独立 undo 栈 + r/fFtT 预读）
  const vimRef = useRef(initialVimState())
  const vimRegRef = useRef('')
  const vimUndoRef = useRef<VimHistory>(initialVimHistory())
  const vimPendingReadRef = useRef<null | 'replace' | 'find'>(null)
  const [vimModeUi, setVimModeUi] = useState<VimMode>('insert')
  const [vimSearchUi, setVimSearchUi] = useState<string | null>(null)

  const cbChange = useRef(onChange)
  const cbSubmit = useRef(onSubmit)
  const cbPaste = useRef(onPaste)
  cbChange.current = onChange
  cbSubmit.current = onSubmit
  cbPaste.current = onPaste

  const raw = self.current ? vRef.current : value
  const display = mask ? raw.replace(/[^\n]/g, mask[0] ?? '*') : raw

  const selected = useMemo(
    () =>
      sel && sel.start !== sel.end ? { end: Math.max(sel.start, sel.end), start: Math.min(sel.start, sel.end) } : null,
    [sel]
  )

  // Read `curRef.current` (always up-to-date) rather than the `cur`
  // React state. The fast-echo path defers the React `setCur` by 16ms
  // to batch re-renders during heavy typing; if an unrelated render
  // flushes this component during that window and we used the stale
  // `cur` state here, the layout effect inside `useDeclaredCursor`
  // would publish a stale cursor declaration and clobber the Ink-level
  // bump from `noteCursorAdvance(...)`. `cur` is still in scope and
  // referenced by setSel/setCur paths below, so React tracks the
  // dependency naturally — we just don't use it as the source of truth
  // for layout. The cursorLayout call is cheap (one wrap-text pass
  // over a single-line string in the common case), so dropping useMemo
  // is fine.
  const layout = cursorLayout(display, curRef.current, columns)

  const boxRef = useDeclaredCursor({
    line: layout.line,
    column: layout.column,
    active: focus && termFocus && !selected
  })

  // Hide the hardware cursor while a selection is active (prevents
  // auto-wrap onto the next row when inverted text fills the column
  // exactly) or when the terminal loses focus (suppresses the hollow-rect
  // ghost most terminals draw at the parked position).
  // A16：占位符显示时隐藏硬件光标（参考同款——否则光标停在占位符上造成歧义），
  // 用合成 chip 指示输入起点
  const showingPlaceholder = !display && !!placeholder
  const hideHardwareCursor = focus && !!stdout?.isTTY && (!!selected || !termFocus || showingPlaceholder)

  useEffect(() => {
    if (!hideHardwareCursor || !stdout) {
      return
    }

    stdout.write('\x1b[?25l')

    return () => {
      stdout.write('\x1b[?25h')
    }
  }, [hideHardwareCursor, stdout])

  const nativeCursor = focus && termFocus && !selected && !!stdout?.isTTY

  // Placeholder text is just a hint, not a selection — render it dim
  // without inverse styling. In a TTY the hardware cursor parks at column
  // 0 and visually marks the input start. Non-TTY surfaces still need the
  // synthetic inverse first-char to draw a cursor at all.
  const rendered = useMemo(() => {
    // ② 波 1：token 高亮（gemini highlight.ts:29-57 对标）——斜杠命令/@提及/占位符
    // 内联 ANSI 着色；仅无光标装饰的路径应用（选区/合成光标路径保持既有视觉契约）
    const displayHi = highlightInputAnsi(display)
    // 波 3 ②：NORMAL 徽标（gemini Composer.tsx:158-165 对标——normal 模式前缀暗色标记）
    // P3 评估轮：/ 搜索挂起时徽标显示实时查询（/query），退出搜索恢复模式徽标
    const normalPrefix = vimEnabled && vimModeUi !== 'insert'
      ? dim(vimSearchUi !== null ? `/${vimSearchUi}` : (vimModeUi === 'visual' ? '-- VISUAL -- ' : '-- NORMAL -- '))
      : ''
    if (!focus) {
      return displayHi || dim(placeholder)
    }

    if (!display && placeholder) {
      // A16：统一合成光标 chip（硬件光标已隐藏）——首字符 inverse + 其余 dim
      return invert(placeholder[0] ?? ' ') + dim(placeholder.slice(1))
    }

    if (selected) {
      return renderWithSelection(display, selected.start, selected.end)
    }

    return nativeCursor ? normalPrefix + (displayHi || ' ') : normalPrefix + renderWithCursor(display, cur)
  }, [cur, display, focus, nativeCursor, placeholder, selected, vimEnabled, vimModeUi, vimSearchUi])

  useEffect(() => {
    if (self.current) {
      self.current = false
    } else {
      setCur(value.length)
      setSel(null)
      curRef.current = value.length
      selRef.current = null
      vRef.current = value
      lineWidthRef.current = stringWidth(value.includes('\n') ? value.slice(value.lastIndexOf('\n') + 1) : value)
      undo.current = []
      redo.current = []
    }
  }, [value])

  useEffect(() => {
    if (!focus) {
      return
    }

    const dropSel = () => {
      if (!selRef.current) {
        return
      }

      selRef.current = null
      setSel(null)
    }

    setInputSelection({
      clear: dropSel,
      collapseToEnd: () => {
        dropSel()
        setCur(vRef.current.length)
        curRef.current = vRef.current.length
      },
      end: selected?.end ?? curRef.current,
      start: selected?.start ?? curRef.current,
      value: vRef.current
    })

    return () => setInputSelection(null)
  }, [cur, focus, selected])

  useEffect(
    () => () => {
      if (keyBurstTimer.current) {
        clearTimeout(keyBurstTimer.current)
      }

      if (parentChangeTimer.current) {
        clearTimeout(parentChangeTimer.current)
      }

      if (localRenderTimer.current) {
        clearTimeout(localRenderTimer.current)
      }
    },
    []
  )

  const flushParentChange = () => {
    if (parentChangeTimer.current) {
      clearTimeout(parentChangeTimer.current)
      parentChangeTimer.current = null
    }

    const next = pendingParentValue.current
    pendingParentValue.current = null

    if (next !== null) {
      self.current = true
      cbChange.current(next)
    }
  }

  const scheduleParentChange = (next: string) => {
    pendingParentValue.current = next

    if (parentChangeTimer.current) {
      return
    }

    parentChangeTimer.current = setTimeout(flushParentChange, FRAME_BATCH_MS)
  }

  const cancelLocalRender = () => {
    if (localRenderTimer.current) {
      clearTimeout(localRenderTimer.current)
      localRenderTimer.current = null
    }
  }

  const scheduleLocalRender = () => {
    if (localRenderTimer.current) {
      return
    }

    localRenderTimer.current = setTimeout(() => {
      localRenderTimer.current = null
      setCur(curRef.current)
    }, FRAME_BATCH_MS)
  }

  const canFastEchoBase = () => supportsFastEchoTerminal() && focus && termFocus && !selected && !mask && !!stdout?.isTTY

  const canFastAppend = (current: string, cursor: number, text: string) =>
    canFastEchoBase() && canFastAppendShape(current, cursor, text, columns, lineWidthRef.current)

  const canFastBackspace = (current: string, cursor: number) =>
    canFastEchoBase() && canFastBackspaceShape(current, cursor, columns)

  const commit = (
    next: string,
    nextCur: number,
    track = true,
    syncParent = true,
    syncLocal = true,
    nextLineWidth?: number
  ) => {
    const prev = vRef.current
    const c = snapPos(next, nextCur)
    editVersionRef.current += 1

    if (selRef.current) {
      selRef.current = null
      setSel(null)
    }

    if (track && next !== prev) {
      undo.current.push({ cursor: curRef.current, value: prev })

      if (undo.current.length > 200) {
        undo.current.shift()
      }

      redo.current = []
    }

    if (syncLocal) {
      cancelLocalRender()
      setCur(c)
    } else {
      scheduleLocalRender()
    }

    curRef.current = c
    vRef.current = next
    lineWidthRef.current =
      nextLineWidth ?? stringWidth(next.includes('\n') ? next.slice(next.lastIndexOf('\n') + 1) : next)

    if (next !== prev) {
      if (syncParent) {
        flushParentChange()
        self.current = true
        cbChange.current(next)
      } else {
        self.current = true
        scheduleParentChange(next)
      }
    }
  }

  const swap = (from: typeof undo, to: typeof redo) => {
    const entry = from.current.pop()

    if (!entry) {
      return
    }

    to.current.push({ cursor: curRef.current, value: vRef.current })
    commit(entry.value, entry.cursor, false)
  }

  const emitPaste = (e: PasteEvent) => {
    const startVersion = editVersionRef.current
    const h = cbPaste.current?.(e)

    if (isPasteResultPromise(h)) {
      const fallbackText = e.text

      void h
        .then(result => {
          if (result && editVersionRef.current === startVersion) {
            commit(result.value, result.cursor)
          } else if (result && fallbackText && PRINTABLE.test(fallbackText)) {
            // User typed while async paste was in-flight — fall back to raw text insert
            // so the pasted content is not silently lost.
            const cur = curRef.current
            const v = vRef.current
            commit(v.slice(0, cur) + fallbackText + v.slice(cur), cur + fallbackText.length)
          }
        })
        .catch(() => {})

      return true
    }

    if (h) {
      commit(h.value, h.cursor)
    }

    return !!h
  }

  const flushKeyBurst = () => {
    if (keyBurstTimer.current) {
      clearTimeout(keyBurstTimer.current)
      keyBurstTimer.current = null
    }

    flushParentChange()
  }

  const scheduleKeyBurstCommit = (next: string, nextCur: number) => {
    commit(next, nextCur, true, false, false)

    if (keyBurstTimer.current) {
      return
    }

    keyBurstTimer.current = setTimeout(() => {
      keyBurstTimer.current = null
      flushParentChange()
    }, FRAME_BATCH_MS)
  }

  const clearSel = () => {
    if (!selRef.current) {
      return
    }

    selRef.current = null
    setSel(null)
  }

  /** A19：设置选区（start===end 时等价于清除——双击空白不产生选区）。 */
  const setSelRange = (start: number, end: number) => {
    if (start === end) {
      clearSel()

      return
    }

    const next = { start, end }
    selRef.current = next
    setSel(next)
  }

  const selectAll = () => {
    const end = vRef.current.length

    if (!end) {
      return
    }

    const next = { end, start: 0 }
    selRef.current = next
    setSel(next)
    setCur(end)
    curRef.current = end
  }

  const moveCursor = (next: number, extend = false) => {
    const c = snapPos(vRef.current, next)
    const anchor = selRef.current?.start ?? curRef.current

    if (!extend || anchor === c) {
      clearSel()
    } else {
      const nextSel = { end: c, start: anchor }
      selRef.current = nextSel
      setSel(nextSel)
    }

    setCur(c)
    curRef.current = c
  }

  const selRange = () => {
    const range = selRef.current

    return range && range.start !== range.end
      ? { end: Math.max(range.start, range.end), start: Math.min(range.start, range.end) }
      : null
  }

  const ins = (v: string, c: number, s: string) => v.slice(0, c) + s + v.slice(c)

  const pastePlainText = (text: string) => {
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    if (!cleaned) {
      return
    }

    const range = selRange()

    const nextValue = range
      ? vRef.current.slice(0, range.start) + cleaned + vRef.current.slice(range.end)
      : vRef.current.slice(0, curRef.current) + cleaned + vRef.current.slice(curRef.current)

    const nextCursor = range ? range.start + cleaned.length : curRef.current + cleaned.length

    commit(nextValue, nextCursor)
  }

  const startMouseSelection = (next: number) => {
    const c = snapPos(vRef.current, next)

    mouseAnchorRef.current = c
    selRef.current = { end: c, start: c }
    setSel(null)
    setCur(c)
    curRef.current = c
  }

  const dragMouseSelection = (next: number) => {
    if (mouseAnchorRef.current === null) {
      return
    }

    const c = snapPos(vRef.current, next)
    const range = { end: c, start: mouseAnchorRef.current }
    selRef.current = range
    setSel(range.start === range.end ? null : range)
    setCur(c)
    curRef.current = c
  }

  const endMouseSelection = () => {
    mouseAnchorRef.current = null

    const range = selRef.current

    if (range && range.start === range.end) {
      selRef.current = null
      setSel(null)

      return
    }

    const normalized = selRange()

    if (isMac && normalized) {
      void writeClipboardText(vRef.current.slice(normalized.start, normalized.end))
    }
  }

  const offsetAt = (e: { localCol?: number; localRow?: number }) =>
    offsetFromPosition(display, e.localRow ?? 0, e.localCol ?? 0, columns)

  /** A19：多击计数（同偏移 500ms 窗口内递增，cap 4=全选）。press 调用。 */
  const clickCountAt = (offset: number): number => {
    const now = Date.now()
    const last = lastClickRef.current

    if (now - last.at < MULTI_CLICK_MS && offset === last.offset) {
      const count = Math.min(4, last.count + 1)
      lastClickRef.current = { at: now, offset, count }

      return count
    }

    lastClickRef.current = { at: now, offset, count: 1 }

    return 1
  }

  if (mouseApiRef) {
    mouseApiRef.current = {
      dragAt: (row, col) => dragMouseSelection(offsetFromPosition(display, row, col, columns)),
      end: endMouseSelection,
      startAtBeginning: () => startMouseSelection(0)
    }
  }

  useInput(
    (inp: string, k: Key, event: InputEvent) => {
      const eventRaw = event.keypress.raw

      // Configured voice shortcut wins over composer-level defaults like
      // paste/copy so users who bind voice to ctrl+v / alt+v / cmd+v
      // actually get voice toggled instead of a paste (Copilot round-7
      // follow-up on #19835). The pass-through predicate is a no-op for
      // ordinary typing and plain paste when voice is unbound to 'v'.
      if (shouldPassThroughToGlobalHandler(inp, k, voiceRecordKey)) {
        flushKeyBurst()

        return
      }

      // 波 3 ②：vim 模态按键拦截（vimEnabled 且 normal 模式全拦截；insert 模式仅截 Esc 回 normal）
      if (vimEnabled && (vimRef.current.mode !== 'insert' || k.escape)) {
        flushKeyBurst()

        if (vimRef.current.mode === 'insert') {
          const esc = vimHandleKey(vimRef.current, { text: vRef.current, cursor: curRef.current }, 'Escape', Date.now(), vimRegRef.current)
          vimRef.current = esc.state
          setVimModeUi(esc.state.mode)

          return
        }

        // 键名映射：Esc/Enter/Backspace + 无修饰单字符；其余（Ctrl 组合等）不属 vim
        // Ctrl-R = redo（P3 评估轮——/ 搜索外另一六家题）
        let token: string | null = null
        if (k.escape) token = 'Escape'
        else if (k.return) token = 'Enter'
        else if (k.backspace) token = 'Backspace'
        else if (k.ctrl && inp === 'r' && !k.shift && !k.meta && !k.alt) token = '<redo>'
        else if (inp && inp.length === 1 && !k.ctrl && !k.meta && !k.alt) token = inp

        // r/fFtT 预读下一字符（gemini pendingFindOp 同构——两键命令；搜索挂起期不截胡）
        if (vimPendingReadRef.current) {
          if (token && token.length === 1) {
            token = vimPendingReadRef.current === 'replace' ? `<replace:${token}>` : `<find:${token}>`
            vimPendingReadRef.current = null
          } else {
            vimPendingReadRef.current = null // Esc/其他键取消预读

            return
          }
        } else if (!vimRef.current.search && token === 'r') {
          vimPendingReadRef.current = 'replace'

          return
        } else if (!vimRef.current.search && (token === 'f' || token === 'F' || token === 't' || token === 'T')) {
          // f/F/t/T 两键命令：先把操作符送进核心置 pendingOp（<find:ch> 到达时按其执行），
          // 再挂起预读下一字符
          vimRef.current = vimHandleKey(vimRef.current, { text: vRef.current, cursor: curRef.current }, token, Date.now(), vimRegRef.current).state
          vimPendingReadRef.current = 'find'

          return
        }

        if (!token) return

        const doc = { text: vRef.current, cursor: curRef.current }
        const out = vimHandleKey(vimRef.current, doc, token, Date.now(), vimRegRef.current)
        vimRef.current = out.state
        setVimSearchUi(out.state.search ? out.state.search.query : null)
        if (out.yanked) vimRegRef.current = out.yanked
        if (out.cleared) {
          vimUndoRef.current = vimHistoryPush(vimUndoRef.current, doc)
          commit('', 0)
        } else if (out.undo) {
          const r = vimHistoryUndo(vimUndoRef.current, doc)
          if (r) { vimUndoRef.current = r.h; commit(r.doc.text, r.doc.cursor) }
        } else if (out.redo) {
          const r = vimHistoryRedo(vimUndoRef.current, doc)
          if (r) { vimUndoRef.current = r.h; commit(r.doc.text, r.doc.cursor) }
        } else if (out.doc.text !== vRef.current) {
          if (out.undoable) vimUndoRef.current = vimHistoryPush(vimUndoRef.current, doc)
          commit(out.doc.text, out.doc.cursor)
        } else if (out.doc.cursor !== curRef.current) {
          commit(out.doc.text, out.doc.cursor)
        }
        setVimModeUi(out.state.mode)

        return
      }

      // ② 波 1：Ctrl+O 外部编辑器（kimi editor.py:18-50 探测链 + crush ui.go:3688-3725
      // 临时文件往返）——当前草稿写临时文件 → 阻塞等编辑器退出 → 读回替换。
      // 失败（编辑器缺失/超时）诚实保留草稿——输入不丢。
      if (k.ctrl && inp === 'o' && !k.shift && !k.meta && !k.alt) {
        flushKeyBurst()

        const res = runExternalEditor({
          command: resolveEditorCommand(),
          fallback: process.platform === 'win32' ? [['notepad']] : [['vi']],
          text: vRef.current,
        })
        if (res.ok) {
          const next = res.text.replace(/\n+$/, '')
          if (next !== vRef.current) {
            commit(next, next.length)
          }
        }
        // 失败静默保留草稿（无通知通道——避免打断输入；error 详情在返回结构中可审计）

        return
      }

      if (
        eventRaw === '\x1bv' ||
        eventRaw === '\x1bV' ||
        eventRaw === '\x16' ||
        (isMac && isActionMod(k) && inp.toLowerCase() === 'v')
      ) {
        flushKeyBurst()

        if (cbPaste.current) {
          return void emitPaste({ cursor: curRef.current, hotkey: true, text: '', value: vRef.current })
        }

        if (isMac) {
          void readClipboardText().then(text => {
            if (text) {
              pastePlainText(text)
            }
          })
        }

        return
      }

      if (isMac && isActionMod(k) && inp.toLowerCase() === 'c') {
        flushKeyBurst()

        const range = selRange()

        if (range) {
          const text = vRef.current.slice(range.start, range.end)

          void writeClipboardText(text)
        }

        return
      }

      if (k.upArrow || k.downArrow) {
        flushKeyBurst()

        const next = lineNav(vRef.current, curRef.current, k.upArrow ? -1 : 1)

        if (next !== null) {
          moveCursor(next, k.shift)

          return
        }

        return
      }

      if (k.return) {
        flushKeyBurst()

        const sequence = (event.keypress as { sequence?: string }).sequence
        const preserveBareLineFeed = shouldPreserveCtrlJNewline() && sequence === '\n'

        if (k.shift || k.ctrl || preserveBareLineFeed || (isMac ? isActionMod(k) : k.meta)) {
          commit(ins(vRef.current, curRef.current, '\n'), curRef.current + 1)
        } else {
          cbSubmit.current?.(vRef.current)
        }

        return
      }

      let c = curRef.current
      let v = vRef.current
      const mod = isActionMod(k)
      const wordMod = mod || k.meta
      const actionHome = k.home || (!isMac && mod && inp === 'a') || isMacActionFallback(k, inp, 'a')
      const actionEnd = k.end || (mod && inp === 'e') || isMacActionFallback(k, inp, 'e')
      const actionDeleteToStart = (mod && inp === 'u') || isMacActionFallback(k, inp, 'u')
      const actionKillToEnd = (mod && inp === 'k') || isMacActionFallback(k, inp, 'k')
      const actionDeleteWord = (mod && inp === 'w') || isMacActionFallback(k, inp, 'w')
      const range = selRange()
      const delFwd = k.delete || fwdDel.current
      const isPrintableInput = (event.keypress.isPasted || inp.length > 0) && PRINTABLE.test(inp.replace(BRACKET_PASTE, ''))

      if (!isPrintableInput) {
        flushKeyBurst()
      }

      if (mod && inp === 'z') {
        return swap(undo, redo)
      }

      if ((mod && inp === 'y') || (mod && k.shift && inp === 'z')) {
        return swap(redo, undo)
      }

      if (isMac && mod && inp === 'a') {
        return selectAll()
      }

      if (actionHome) {
        c = 0
        moveCursor(c, k.shift)

        return
      } else if (actionEnd) {
        c = v.length
        moveCursor(c, k.shift)

        return
      } else if (k.leftArrow) {
        if (range && !wordMod && !k.shift) {
          clearSel()
          c = range.start
        } else {
          c = wordMod ? wordLeft(v, c) : prevPos(v, c)
        }

        moveCursor(c, k.shift)

        return
      } else if (k.rightArrow) {
        if (range && !wordMod && !k.shift) {
          clearSel()
          c = range.end
        } else {
          c = wordMod ? wordRight(v, c) : nextPos(v, c)
        }

        moveCursor(c, k.shift)

        return
      } else if (wordMod && inp === 'b') {
        clearSel()
        c = wordLeft(v, c)
      } else if (wordMod && inp === 'f') {
        clearSel()
        c = wordRight(v, c)
      } else if (range && (k.backspace || delFwd)) {
        v = v.slice(0, range.start) + v.slice(range.end)
        c = range.start
      } else if (k.backspace && c > 0) {
        if (wordMod) {
          const t = wordLeft(v, c)
          v = v.slice(0, t) + v.slice(c)
          c = t
        } else if (canFastBackspace(v, c)) {
          const t = prevPos(v, c)
          v = v.slice(0, t) + v.slice(c)
          c = t
          stdout!.write('\b \b')
          // The "\b \b" sequence ends with the cursor one column to the
          // LEFT of where Ink last parked it. Tell Ink so its `displayCursor`
          // (and log-update's relative-move basis on the next frame) stays
          // in sync — otherwise the cursor parks one cell to the right of
          // the caret on the next unrelated re-render.
          noteCursorAdvance(-1)
          commit(v, c, true, false, false, Math.max(0, lineWidthRef.current - 1))

          return
        } else {
          const t = prevPos(v, c)
          v = v.slice(0, t) + v.slice(c)
          c = t
        }
      } else if (delFwd && c < v.length) {
        if (wordMod) {
          const t = wordRight(v, c)
          v = v.slice(0, c) + v.slice(t)
        } else {
          v = v.slice(0, c) + v.slice(nextPos(v, c))
        }
      } else if (actionDeleteWord) {
        if (range) {
          v = v.slice(0, range.start) + v.slice(range.end)
          c = range.start
        } else if (c > 0) {
          clearSel()
          const t = wordLeft(v, c)
          v = v.slice(0, t) + v.slice(c)
          c = t
        } else {
          return
        }
      } else if (actionDeleteToStart) {
        if (range) {
          v = v.slice(0, range.start) + v.slice(range.end)
          c = range.start
        } else {
          // A5 修复：多行输入按逻辑行删除（参考 killToLineStart 同款）——删到当前行首
          const lineStart = v.lastIndexOf('\n', c - 1) + 1
          v = v.slice(0, lineStart) + v.slice(c)
          c = lineStart
        }
      } else if (actionKillToEnd) {
        if (range) {
          v = v.slice(0, range.start) + v.slice(range.end)
          c = range.start
        } else {
          // A5：删到当前行尾（保留换行与后续行；单行时等价原行为）
          const nl = v.indexOf('\n', c)
          const lineEnd = nl === -1 ? v.length : nl
          v = v.slice(0, c) + v.slice(lineEnd)
        }
      } else if (event.keypress.isPasted || inp.length > 0) {
        const bracketed = event.keypress.isPasted || inp.includes('[200~')
        const text = inp.replace(BRACKET_PASTE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

        if (bracketed && emitPaste({ bracketed: true, cursor: c, text, value: v })) {
          return
        }

        if (!text) {
          return
        }

        if (text === '\n') {
          return commit(ins(v, c, '\n'), c + 1)
        }

        if (text.length > 1 || text.includes('\n')) {
          if (shouldRouteMultiCharInputAsPaste(text)) {
            flushKeyBurst()

            if (!emitPaste({ cursor: c, text, value: v })) {
              commit(ins(v, c, text), c + text.length)
            }

            return
          }

          const inserted = applyPrintableInsert(v, c, text, range)

          if (!inserted) {
            return
          }

          v = inserted.value
          c = inserted.cursor
          scheduleKeyBurstCommit(v, c)

          return
        }

        {
          const inserted = applyPrintableInsert(v, c, text, range)

          if (!inserted) {
            return
          }

          if (range) {
            v = inserted.value
            c = inserted.cursor
          } else {
            const simpleAppend = canFastAppend(v, c, text)

            v = inserted.value
            c = inserted.cursor

            if (simpleAppend) {
              stdout!.write(text)
              // ASCII-printable text advances the physical cursor by exactly
              // text.length cells (canFastAppendShape rejects non-ASCII,
              // wide chars, newlines). Notify Ink so the cached displayCursor
              // / log-update relative-move basis advances with it; otherwise
              // any unrelated re-render that happens before the 16ms
              // setCur/setParent flush parks the cursor text.length cells
              // too far right (#cursor-drift).
              noteCursorAdvance(text.length)
              commit(v, c, true, false, false, lineWidthRef.current + stringWidth(text))

              return
            }
          }
        }
      } else {
        return
      }

      commit(v, c)
    },
    { isActive: focus }
  )

  return (
    <Box
      onClick={(e: MouseEventLite) => {
        if (!focus) {
          return
        }

        e.stopImmediatePropagation?.()

        // A19：多击（选词/选行/全选）后的释放保留高亮——onClick 不再
        // 执行"点击定位+清选区"（否则双击/三击选区在释放瞬间消失）。
        if (lastMultiClickRef.current) {
          lastMultiClickRef.current = false

          return
        }

        clearSel()
        const next = offsetAt(e)
        setCur(next)
        curRef.current = next
      }}
      onMouseDown={(e: MouseEventLite) => {
        if (!focus) {
          return
        }

        // Right-click → copy active selection if any, otherwise paste.
        if (e.button === 2) {
          e.stopImmediatePropagation?.()
          const decision = decideRightClickAction(vRef.current, selRange())

          if (decision.action === 'copy') {
            void writeClipboardText(decision.text)

            return
          }

          emitPaste({ cursor: curRef.current, hotkey: true, text: '', value: vRef.current })

          return
        }

        if (e.button !== 0) {
          return
        }

        e.stopImmediatePropagation?.()
        const offset = offsetAt(e)
        const count = clickCountAt(offset)

        // A19：macOS 语义——双击选词 / 三击选行 / 四击全选（原"双击=全选"升级）。
        if (count >= 2) {
          lastMultiClickRef.current = true
          mouseAnchorRef.current = null

          if (count === 2) {
            const { start, end } = wordBoundsAt(vRef.current, offset)
            setSelRange(start, end)
          } else if (count === 3) {
            const { start, end } = lineBoundsAt(vRef.current, offset)
            setSelRange(start, end)
          } else {
            selectAll()
          }

          return
        }

        startMouseSelection(offset)
      }}
      onMouseDrag={(e: MouseEventLite) => {
        if (!focus || e.button !== 0 || mouseAnchorRef.current === null) {
          return
        }

        e.stopImmediatePropagation?.()
        dragMouseSelection(offsetAt(e))
      }}
      onMouseUp={(e: MouseEventLite) => {
        e.stopImmediatePropagation?.()
        endMouseSelection()
      }}
      ref={boxRef}
      width={columns}
    >
      <Text wrap="wrap">{rendered}</Text>
    </Box>
  )
}

type MouseEventLite = {
  button?: number
  localCol?: number
  localRow?: number
  stopImmediatePropagation?: () => void
}

export interface PasteEvent {
  bracketed?: boolean
  cursor: number
  hotkey?: boolean
  text: string
  value: string
}

interface TextInputProps {
  columns?: number
  focus?: boolean
  mask?: string
  mouseApiRef?: MutableRefObject<null | TextInputMouseApi>
  onChange: (v: string) => void
  onPaste?: (
    e: PasteEvent
  ) => { cursor: number; value: string } | Promise<{ cursor: number; value: string } | null> | null
  onSubmit?: (v: string) => void
  placeholder?: string
  value: string
  voiceRecordKey?: ParsedVoiceRecordKey
  /** 波 3 ②：vim 模态编辑开关（settings.vimMode 经 /vim 切换、配置水合传入） */
  vimEnabled?: boolean
}

export type RightClickDecision =
  | { action: 'copy'; text: string }
  | { action: 'paste' }

/**
 * Decide what right-click should do on the composer:
 *   - non-empty selection → copy that text to the clipboard
 *   - no selection (or empty/collapsed range) → fall through to paste
 *
 * Mirrors terminal-native behavior (xterm, iTerm, gnome-terminal) where
 * right-click pastes only when there is nothing selected to copy.
 *
 * Callers pass the already-normalized range from `selRange()` (start <= end,
 * or null when collapsed), so this helper does not need to re-normalize.
 */
export function decideRightClickAction(
  value: string,
  range: { end: number; start: number } | null
): RightClickDecision {
  if (range && range.end > range.start) {
    const text = value.slice(range.start, range.end)

    if (text) {
      return { action: 'copy', text }
    }
  }

  return { action: 'paste' }
}

export const shouldPassThroughToGlobalHandler = (
  input: string,
  key: Key,
  voiceRecordKey: ParsedVoiceRecordKey = DEFAULT_VOICE_RECORD_KEY
): boolean =>
  (key.ctrl && input === 'c') ||
  (key.ctrl && input === 'x') ||
  key.tab ||
  (key.shift && key.tab) ||
  key.pageUp ||
  key.pageDown ||
  key.escape ||
  isVoiceToggleKey(key, input, voiceRecordKey)

export interface TextInputMouseApi {
  dragAt: (row: number, col: number) => void
  end: () => void
  startAtBeginning: () => void
}
