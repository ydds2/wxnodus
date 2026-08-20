import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { setRendererCapabilities } from './capabilities.js'
import type { Frame } from './frame.js'
import { LogUpdate } from './log-update.js'
import { CellWidth, CharPool, createScreen, HyperlinkPool, type Screen, setCellAt, StylePool } from './screen.js'

/**
 * Contract tests for LogUpdate.render() — the diff-to-ANSI path that owns
 * whether the terminal picks up each React commit correctly.
 *
 * These tests pin down a few load-bearing invariants so that any fix for
 * the "scattered letters after rapid resize" artifact in xterm.js hosts
 * can be grounded against them.
 */

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

const mkScreen = (w: number, h: number) => createScreen(w, h, stylePool, charPool, hyperlinkPool)

const paint = (screen: Screen, y: number, text: string) => {
  for (let x = 0; x < text.length; x++) {
    setCellAt(screen, x, y, {
      char: text[x]!,
      styleId: stylePool.none,
      width: CellWidth.Narrow,
      hyperlink: undefined
    })
  }
}

const mkFrame = (screen: Screen, viewportW: number, viewportH: number, cursorY = 0): Frame => ({
  screen,
  viewport: { width: viewportW, height: viewportH },
  cursor: { x: 0, y: cursorY, visible: true }
})

const stdoutOnly = (diff: ReturnType<LogUpdate['render']>) =>
  diff
    .filter(p => p.type === 'stdout')
    .map(p => (p as { type: 'stdout'; content: string }).content)
    .join('')

const ESC = '\u001b'
const hasDecstbm = (text: string) => new RegExp(`${ESC}\\[\\d+;\\d+r`).test(text)

afterEach(() => {
  setRendererCapabilities(null)
})

describe('LogUpdate.render diff contract', () => {
  // 2026-08-19：diff 契约测试模拟现代终端（WT_SESSION）——conhost 批量行渲染
  // （isClassicConhost）在 win32 测试环境默认命中（无 WT_SESSION/TERM_PROGRAM），
  // 会整行重绘破坏逐 cell 最小 diff 断言；批量路径单独见下方 describe。
  const prevWT = process.env.WT_SESSION
  const prevTERM = process.env.TERM_PROGRAM
  beforeAll(() => {
    process.env.WT_SESSION = '1'
    delete process.env.TERM_PROGRAM
  })
  afterAll(() => {
    if (prevWT === undefined) delete process.env.WT_SESSION
    else process.env.WT_SESSION = prevWT
    if (prevTERM === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = prevTERM
  })

  it('emits only changed cells when most rows match', () => {
    const w = 20
    const h = 4
    const prev = mkScreen(w, h)
    paint(prev, 0, 'HELLO')
    paint(prev, 1, 'WORLD')
    paint(prev, 2, 'STAYSHERE')

    const next = mkScreen(w, h)
    paint(next, 0, 'HELLO')
    paint(next, 1, 'CHANGE')
    paint(next, 2, 'STAYSHERE')
    next.damage = { x: 0, y: 0, width: w, height: h }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, h), mkFrame(next, w, h), true, false)

    const written = stdoutOnly(diff)
    expect(written).toContain('CHANGE')
    expect(written).not.toContain('HELLO')
    expect(written).not.toContain('STAYSHERE')
  })

  it('width change emits a clearTerminal patch before repainting', () => {
    const prevW = 20
    const nextW = 15
    const h = 3

    const prev = mkScreen(prevW, h)
    paint(prev, 0, 'thiswaswiderrow')

    const next = mkScreen(nextW, h)
    paint(next, 0, 'shorterrownow')
    next.damage = { x: 0, y: 0, width: nextW, height: h }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, prevW, h), mkFrame(next, nextW, h), true, false)

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
    expect(stdoutOnly(diff)).toContain('shorterrownow')
  })

  it('height growth emits a clearTerminal patch before repainting', () => {
    const w = 20
    const prevH = 3
    const nextH = 6

    const prev = mkScreen(w, prevH)
    paint(prev, 0, 'old rows')

    const next = mkScreen(w, nextH)
    paint(next, 0, 'new rows')
    next.damage = { x: 0, y: 0, width: w, height: nextH }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, prevH), mkFrame(next, w, nextH), true, false)

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
    expect(stdoutOnly(diff)).toContain('newrows')
  })

  it('drift repro: identical prev/next emits no heal, even when the physical terminal is stale', () => {
    // Load-bearing theory for the rapid-resize scattered-letter bug: if the
    // physical terminal has stale cells that prev.screen doesn't know about
    // (e.g. resize-induced reflow wrote past ink's tracked range), the
    // renderer has no signal to heal them. LogUpdate.render only sees
    // prev/next — no view of the physical terminal — so when prev==next,
    // it emits nothing and any orphaned glyphs survive.
    //
    // The fix path is upstream of this diff: either (a) defensively
    // full-repaint on xterm.js frames where prevFrameContaminated is set,
    // or (b) close the drift window so prev.screen cannot diverge.
    const w = 20
    const h = 3

    const prev = mkScreen(w, h)
    paint(prev, 0, 'same')

    const next = mkScreen(w, h)
    paint(next, 0, 'same')
    next.damage = { x: 0, y: 0, width: w, height: h }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, h), mkFrame(next, w, h), true, false)

    expect(stdoutOnly(diff)).toBe('')
    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  })

  it('ignores main-screen scrollback-only changes instead of resetting repeatedly', () => {
    const w = 20
    const viewportH = 5
    const h = 8

    const prev = mkScreen(w, h)
    paint(prev, 0, 'timer 1s')
    paint(prev, 6, 'visible prompt')

    const next = mkScreen(w, h)
    paint(next, 0, 'timer 2s')
    paint(next, 6, 'visible prompt')
    next.damage = { x: 0, y: 0, width: w, height: h }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, viewportH, h), mkFrame(next, w, viewportH, h), false, false)

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
    expect(stdoutOnly(diff)).not.toContain('timer2s')
  })

  it('keeps alt-screen full reset for unreachable scrollback row changes', () => {
    const w = 20
    const viewportH = 5
    const h = 8

    const prev = mkScreen(w, h)
    paint(prev, 0, 'timer 1s')
    paint(prev, 6, 'visible prompt')

    const next = mkScreen(w, h)
    paint(next, 0, 'timer 2s')
    paint(next, 6, 'visible prompt')
    next.damage = { x: 0, y: 0, width: w, height: h }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, viewportH, h), mkFrame(next, w, viewportH, h), true, false)

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
    expect(stdoutOnly(diff)).toContain('timer2s')
  })

  it('keeps DECSTBM fast-path when scroll region stays above bottom row', () => {
    const w = 12
    const h = 6
    const prev = mkScreen(w, h)
    const next = mkScreen(w, h)

    paint(prev, 1, 'row one')
    paint(next, 1, 'row one')

    const prevFrame = mkFrame(prev, w, h)

    const nextFrame: Frame = {
      ...mkFrame(next, w, h),
      scrollHint: { top: 1, bottom: 4, delta: 1 }
    }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(prevFrame, nextFrame, true, true)

    expect(hasDecstbm(stdoutOnly(diff))).toBe(true)
  })

  it('skips DECSTBM when capability safety is disabled', () => {
    const w = 12
    const h = 6
    const prev = mkScreen(w, h)
    const next = mkScreen(w, h)

    paint(prev, 1, 'row one')
    paint(next, 1, 'row one')

    const nextFrame: Frame = {
      ...mkFrame(next, w, h),
      scrollHint: { top: 1, bottom: 4, delta: 1 }
    }

    setRendererCapabilities({ decstbm: false })
    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, h), nextFrame, true, false)

    expect(hasDecstbm(stdoutOnly(diff))).toBe(false)
  })

  it('skips DECSTBM when scroll region touches the bottom row', () => {
    const w = 12
    const h = 6
    const prev = mkScreen(w, h)
    const next = mkScreen(w, h)

    paint(prev, 1, 'row one')
    paint(next, 1, 'row one')

    const prevFrame = mkFrame(prev, w, h)

    const nextFrame: Frame = {
      ...mkFrame(next, w, h),
      scrollHint: { top: 1, bottom: 5, delta: 1 }
    }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(prevFrame, nextFrame, true, true)

    expect(hasDecstbm(stdoutOnly(diff))).toBe(false)
  })
})

describe('LogUpdate.render conhost batch path (2026-08-19)', () => {
  // 无 WT_SESSION/TERM_PROGRAM（win32 测试环境天然满足）→ isClassicConhost=true：
  // 整行批量重绘——每行一次 CUP + 一次写入（\r\n 换行），无逐 cell 光标定位
  const prevWT = process.env.WT_SESSION
  const prevTERM = process.env.TERM_PROGRAM
  beforeAll(() => {
    delete process.env.WT_SESSION
    delete process.env.TERM_PROGRAM
  })
  afterAll(() => {
    if (prevWT !== undefined) process.env.WT_SESSION = prevWT
    if (prevTERM !== undefined) process.env.TERM_PROGRAM = prevTERM
  })

  it('changed frame emits minimal row-segment writes (2026-08-19 最小重绘)', () => {
    const w = 20
    const h = 3
    const prev = mkScreen(w, h)
    paint(prev, 0, 'AAAA')
    paint(prev, 1, 'KEEP')
    const next = mkScreen(w, h)
    paint(next, 0, 'BBBB')
    paint(next, 1, 'KEEP')

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, h), mkFrame(next, w, h), true, false)
    const out = stdoutOnly(diff)

    // 只重写变化区间：BBBB 出现、未变行 KEEP 不重写
    expect(out).toContain('BBBB')
    expect(out).not.toContain('KEEP')
    // 行定位次数远小于逐 cell 的 w×h 次（每脏行至多 1 次定位）
    const moves = diff.filter(p => p.type === 'cursorTo').length
    expect(moves).toBeLessThan(w * h)
  })

  it('never writes the last column (2026-08-19 pending-wrap 行漂移防护)', () => {
    const w = 20
    const h = 1
    const prev = mkScreen(w, h)
    paint(prev, 0, 'AAAAAAAAAAAAAAAAAA') // 18 列，末列前
    const next = mkScreen(w, h)
    paint(next, 0, 'BBBBBBBBBBBBBBBBBBBB') // 写满 20 列（末列有内容）
    prev.damage = undefined
    next.damage = { x: 0, y: 0, width: w, height: h }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(mkFrame(prev, w, h + 1, 0), mkFrame(next, w, h + 1, 0), true, false)
    const out = stdoutOnly(diff)

    // 末列（第 20 列）的字符绝不写入——写满末列触发 conhost pending-wrap 行漂移
    // 19 个 B 出现（col 0..18），第 20 个 B（末列）被丢弃
    expect(out).toContain('B'.repeat(19))
    expect(out).not.toContain('B'.repeat(20))

    const lastColumnOnly = mkScreen(w, h)
    paint(lastColumnOnly, 0, 'AAAAAAAAAAAAAAAAAAAB')
    lastColumnOnly.damage = { x: w - 1, y: 0, width: 1, height: h }
    const lastColumnDiff = log.render(
      mkFrame(prev, w, h + 1, 0),
      mkFrame(lastColumnOnly, w, h + 1, 0),
      true,
      false
    )

    expect(stdoutOnly(lastColumnDiff)).not.toContain('B')
  })

  it('scroll frame repaints the whole scrollHint region (2026-08-19 拉顶修复)', () => {
    // ScrollBox 滚动帧：blit+shift 后 damage 只覆盖新滚入的底部边行，
    // 顶部滚入行不在 damage 内——无 DECSTBM 的 conhost 上必须整区重绘，
    // 否则顶部行内容缺失（真机复现「运行中拉顶/锁死在首页」）。
    const w = 20
    const h = 6
    const prev = mkScreen(w, h)
    paint(prev, 0, 'OLDTOP') // 滚出区（旧顶行，滚出可视区）
    paint(prev, 1, 'MOVEDUP') // 将滚入顶部可视区
    paint(prev, 2, 'STABLE2')
    paint(prev, 3, 'STABLE3')
    paint(prev, 4, 'STABLE4')
    paint(prev, 5, 'STABLE5')

    const next = mkScreen(w, h)
    paint(next, 0, 'MOVEDUP') // 内容整体上移 1 行
    paint(next, 1, 'STABLE2')
    paint(next, 2, 'STABLE3')
    paint(next, 3, 'STABLE4')
    paint(next, 4, 'STABLE5')
    paint(next, 5, 'NEWROW')
    // 真实管线：prev.screen 是上一帧的 OUTPUT（resetScreen 每帧清 damage），
    // 滚动快路径只给 next 标底部边行 damage（顶部滚入行不在 damage 内）
    prev.damage = undefined
    next.damage = { x: 0, y: 4, width: w, height: 2 }

    const log = new LogUpdate({ isTTY: true, stylePool })
    const diff = log.render(
      mkFrame(prev, w, h + 1, 0),
      { ...mkFrame(next, w, h + 1, h - 1), scrollHint: { top: 0, bottom: 4, delta: 1 } },
      true,
      false
    )
    const out = stdoutOnly(diff)

    // 顶部滚入行必须被重绘（无 DECSTBM 兜底时这是唯一绘制机会）
    expect(out).toContain('MOVEDUP')
    // 滚动区各行全部重绘（STABLE2 亦被移位，需重写）
    expect(out).toContain('STABLE2')
    // 不发生整屏重置（仍在区域内，无需 clearTerminal）
    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  })
})
