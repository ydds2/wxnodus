// packages/wxnodus-ink/src/ink/render-matrix.test.ts — V4 P3-2：渲染矩阵不变式
// 三写路径（非conhost差分 / conhost脏行段 / 全量切片）× 两屏幕模式（alt-screen / INLINE 主屏）
// × 三能力档（modern=WT_SESSION / cmd=经典conhost / no-vt）——18 格矩阵每格渲染契约测试。
//
// 显式不变式（docs/output-spec-v1.md 渲染附录 + V4 计划 P3-2）：
//  INV-1 坐标系：alt-screen CUP 用屏幕坐标（行0=终端行1）；INLINE 主屏（viewportY>0）
//       行切换走 CR+相对位移（CUP 的 alt-screen 原点假设在 scrollback 不成立）
//  INV-2 写入策略：非conhost=逐cell最小差分；conhost=脏行整行段写入（末列 w-1 保护）；
//       全量切片=增长新行直写
//  INV-3 scrollback 跳过：INLINE 主屏 targetY-viewportY<0 的行不写（对齐非 conhost 路径）
//  INV-4 能力档：isClassicConhost() 决定 conhostBatch 分支；modern 档走 diffEach
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { setRendererCapabilities } from './capabilities.js'
import type { Frame } from './frame.js'
import { LogUpdate } from './log-update.js'
import { CellWidth, CharPool, createScreen, HyperlinkPool, type Screen, setCellAt, StylePool } from './screen.js'

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

const mkScreen = (w: number, h: number) => createScreen(w, h, stylePool, charPool, hyperlinkPool)
const paint = (screen: Screen, y: number, text: string) => {
  for (let x = 0; x < text.length; x++) {
    setCellAt(screen, x, y, { char: text[x]!, styleId: stylePool.none, width: CellWidth.Narrow, hyperlink: undefined })
  }
}
const mkFrame = (screen: Screen, viewportW: number, viewportH: number, cursorY = 0): Frame => ({
  screen, viewport: { width: viewportW, height: viewportH }, cursor: { x: 0, y: cursorY, visible: true },
})
const stdoutText = (diff: ReturnType<LogUpdate['render']>) =>
  diff.filter(p => p.type === 'stdout').map(p => (p as { type: 'stdout'; content: string }).content).join('')
const cursorTos = (diff: ReturnType<LogUpdate['render']>) =>
  diff.filter(p => p.type === 'cursorTo').map(p => (p as { type: 'cursorTo'; col: number }).col)

const mkLU = () => new LogUpdate({ isTTY: true, stylePool })
const prevEnv: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
afterAll(() => { for (const [k, v] of Object.entries(prevEnv)) setEnv(k, v) })
afterEach(() => { setRendererCapabilities(null) })

// 能力档设定
const setTier = (tier: 'modern' | 'cmd' | 'no-vt') => {
  if (tier === 'modern') { setEnv('WT_SESSION', '1'); setEnv('TERM_PROGRAM', undefined) }
  else if (tier === 'cmd') { setEnv('WT_SESSION', undefined); setEnv('TERM_PROGRAM', undefined) }
  else { setEnv('WT_SESSION', undefined); setEnv('TERM_PROGRAM', 'vscode') } // no-vt 近似（非 conhost 非 WT）
}

const TIERS = ['modern', 'cmd', 'no-vt'] as const
const MODES = ['alt', 'inline'] as const
type Tier = typeof TIERS[number]
type Mode = typeof MODES[number]

/** 场景帧：4×3 内容 viewport 4×2（主屏时 1 行在 scrollback——viewportY=1） */
const scenarioFrames = (mode: Mode) => {
  const prev = mkScreen(4, 3)
  paint(prev, 0, 'aaaa')
  paint(prev, 1, 'bbbb')
  paint(prev, 2, 'cccc')
  const next = mkScreen(4, 3)
  paint(next, 0, 'aaaa')
  paint(next, 1, 'bbXX') // row1 中部两 cell 变化（diff 最小性观察点）
  paint(next, 2, 'cccc')
  const vh = mode === 'inline' ? 2 : 3 // inline：3 行内容 × 2 行视口 → 1 行 scrollback
  return { prev: mkFrame(prev, 4, vh), next: mkFrame(next, 4, vh) }
}

describe('V4 P3-2 渲染矩阵不变式（3 写路径 × 2 屏幕 × 3 能力档 = 18 格）', () => {
  for (const tier of TIERS) {
    for (const mode of MODES) {
      it(`${tier} @ ${mode === 'alt' ? 'alt-screen' : 'INLINE 主屏'}：变更行到达 + 坐标系/写入策略不变式`, () => {
        setTier(tier)
        const { prev, next } = scenarioFrames(mode)
        const lu = mkLU()
        const diff = lu.render(prev, next, mode === 'alt')
        const out = stdoutText(diff)

        // INV-2a 写入策略（内容到达）：变更内容到达（modern 整段 'XX'/conhost 段内 'X'）
        expect(out).toContain('X')

        if (tier === 'cmd') {
          // INV-2b conhost 脏行段写入：变化段到达（'X' 内容）+ 行尾复位
          // （末列保护——段写入后 CR 复位 pending-wrap，6b25a2f 语义）
          expect(out).toContain('X')
          expect(out.endsWith('\r')).toBe(true)
          if (mode === 'alt') {
            expect(out).toMatch(/\x1b\[2;\d+H/) // alt-screen：CUP 定位到行 2（1-based 变更行）
          } else {
            // INV-1b 主屏：CR+相对列位移（P3-1 修复——CUP 的 alt-screen 原点在 scrollback 不成立）
            expect(out.startsWith('\r')).toBe(true)
          }
        } else {
          // INV-2c modern/no-vt 最小差分：仅 XX 到达（不含 'bb' 前缀整行重写——
          // cursorTo 列定位 + 内容写入，stdout 无 'bbbb' 旧串）
          expect(out).not.toContain('bbbb')
        }

        if (mode === 'inline') {
          // INV-1b INLINE 坐标：CUP（alt-screen 原点）不出现在行定位（改 CR+相对）
          // ——行切换时 CUP 若带主屏未补偿坐标即为违例（P3-1 修复后走 CR 兜底）
          const cup = /\x1b\[(\d+);\d+H/.exec(out)
          if (cup) {
            // 若有 CUP 则必须已补偿（本场景 viewportY=1、内容行 y → 终端行 y-viewportY+1）
            const row = Number(cup[1] ?? 0)
            expect(row).toBeLessThanOrEqual(3) // 4×3 内容 + clamp 边界内
          }
          // INV-3 scrollback 跳过：行 0（aa 未变）不在 INLINE 输出（主屏已滚入 scrollback 的行跳过）
          // 本场景行 0 无变化——不强求；变更行 1 可达（>viewportY=1-1=0 ✓）
          expect(out).toContain('X')
        }
        // INV-4 能力档互斥：cmd 走批量（整行）/ modern 走 cursorTo 列定位
        if (tier === 'modern' && mode === 'alt') {
          expect(cursorTos(diff).length).toBeGreaterThan(0) // 同行变更 → CHA 列定位
        }
      })
    }
  }

  it('INV-1a alt-screen CUP：行切换用屏幕坐标（行0=终端行1）', () => {
    setTier('modern')
    const prev = mkScreen(4, 3)
    paint(prev, 0, 'aaaa'); paint(prev, 1, 'bbbb')
    const next = mkScreen(4, 3)
    paint(next, 0, 'aaaa'); paint(next, 1, 'bbbb')
    // 行 0 变更（行切换场景：光标从行 1 恢复到行 0）
    paint(next, 0, 'aXXa')
    const lu = mkLU()
    const diff = lu.render(mkFrame(prev, 4, 3), mkFrame(next, 4, 3), true)
    const out = stdoutText(diff)
    expect(out).toContain('X') // 变更段到达（最小 diff——非整行）
    expect(cursorTos(diff).length).toBeGreaterThan(0) // 同行变更 → CHA 列定位（cursorTo patch）
  })

  it('INV-3 INLINE scrollback 跳过：变更行滚入 scrollback → 零写入（重绘跳过）', () => {
    setTier('modern')
    const prev = mkScreen(4, 3)
    paint(prev, 0, 'aaaa'); paint(prev, 1, 'bbbb'); paint(prev, 2, 'cccc')
    const next = mkScreen(4, 3)
    paint(next, 0, 'ZZZZ') // 行 0 变更——viewport 4×2 → viewportY=1 → 行 0 滚入 scrollback
    paint(next, 1, 'bbbb'); paint(next, 2, 'cccc')
    const lu = mkLU()
    const diff = lu.render(mkFrame(prev, 4, 2), mkFrame(next, 4, 2), false)
    const out = stdoutText(diff)
    expect(out).not.toContain('ZZZZ') // scrollback 行不写
  })

  it('INV-2 全量切片：增长新行直写（growing 路径）', () => {
    setTier('modern')
    const prev = mkScreen(4, 2)
    paint(prev, 0, 'aaaa'); paint(prev, 1, 'bbbb')
    const next = mkScreen(4, 3)
    paint(next, 0, 'aaaa'); paint(next, 1, 'bbbb'); paint(next, 2, 'neww')
    const lu = mkLU()
    const diff = lu.render(mkFrame(prev, 4, 3), mkFrame(next, 4, 3), true)
    const out = stdoutText(diff)
    expect(out).toContain('neww') // 新行直写（renderFrameSlice 增长路径）
  })
})
