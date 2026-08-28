import { cursorLayout, offsetFromPosition } from './inputMetrics.js'
import { isTermuxTuiMode } from './termux.js'

// src/wxnodus-ui/lib/textInputModel.ts — 输入区纯函数模型（V4 UI 重构：自 textInput.tsx 整体迁出）
// 字素导航/词行边界/可打印插入/快回显形状判定/选区渲染——组件壳只留 JSX+hooks。
// 导出面与迁出前一致（textInput.tsx re-export 保持既有测试导入路径兼容）。
export const ESC = '\x1b'
export const INV = `${ESC}[7m`
export const INV_OFF = `${ESC}[27m`
export const DIM = `${ESC}[2m`
export const DIM_OFF = `${ESC}[22m`
export const FWD_DEL_RE = new RegExp(`${ESC}\\[3(?:[~$^]|;)`)
export const PRINTABLE = /^[ -~\u00a0-\uffff]+$/
export const BRACKET_PASTE = new RegExp(`${ESC}?\\[20[01]~`, 'g')
export const FRAME_BATCH_MS = 16
export const MULTI_CLICK_MS = 500
type MinimalEnv = Record<string, string | undefined>

// ── A19：双击选词/三击选行（输入框字符串版——参考 ink 选区同款语义）──
// 词字符：字母/数字/下划线/斜杠/点/连字符/加号/波浪号/反斜杠（iTerm2 默认词字符）
export const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

export const charClass = (ch: string | undefined): number => {
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

export const invert = (s: string) => INV + s + INV_OFF
export const dim = (s: string) => DIM + s + DIM_OFF

export let _seg: Intl.Segmenter | null = null
export const seg = () => (_seg ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }))
export const STOP_CACHE_MAX = 32
export const stopCache = new Map<string, number[]>()

export function graphemeStops(s: string) {
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

export function snapPos(s: string, p: number) {
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

export function prevPos(s: string, p: number) {
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

export function nextPos(s: string, p: number) {
  const pos = snapPos(s, p)

  for (const stop of graphemeStops(s)) {
    if (stop > pos) {
      return stop
    }
  }

  return s.length
}

export function wordLeft(s: string, p: number) {
  let i = snapPos(s, p) - 1

  while (i > 0 && /\s/.test(s[i]!)) {
    i--
  }

  while (i > 0 && !/\s/.test(s[i - 1]!)) {
    i--
  }

  return Math.max(0, i)
}

export function wordRight(s: string, p: number) {
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

export const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/

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

export function renderWithCursor(value: string, cursor: number) {
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

export function renderWithSelection(value: string, start: number, end: number) {
  if (start >= end) {
    return value
  }

  return value.slice(0, start) + invert(value.slice(start, end) || ' ') + value.slice(end)
}


type PasteResult = { cursor: number; value: string } | null

export const isPasteResultPromise = (
  value: PasteResult | Promise<PasteResult> | null | undefined
): value is Promise<PasteResult> => !!value && typeof (value as PromiseLike<PasteResult>).then === 'function'
