// src/wxnodus-ui/banner.ts — 品牌横幅：高精度像素徽标（逐格背景色）+ 皮肤富文本兼容
import { mix, type ThemeColors } from './theme.js'

const RICH_RE = /\[(?:bold\s+)?(?:dim\s+)?(#(?:[0-9a-fA-F]{3,8}))\]([\s\S]*?)(\[\/\])/g

export function parseRichMarkup(markup: string): Line[] {
  const lines: Line[] = []

  for (const raw of markup.split('\n')) {
    const trimmed = raw.trimEnd()

    if (!trimmed) {
      lines.push(['', ' '])

      continue
    }

    const matches = [...trimmed.matchAll(RICH_RE)]

    if (!matches.length) {
      lines.push(['', trimmed])

      continue
    }

    let cursor = 0

    for (const m of matches) {
      const before = trimmed.slice(cursor, m.index)

      if (before) {
        lines.push(['', before])
      }

      lines.push([m[1]!, m[2]!])
      cursor = m.index! + m[0].length
    }

    if (cursor < trimmed.length) {
      lines.push(['', trimmed.slice(cursor)])
    }
  }

  return lines
}

// ── 高精度像素徽标（逐格背景色渲染 · 2026-08-19 用户指定）────────────────
// 设计：黑洞事件视界剖面——椭圆距离场着色器逐格计算（确定性、任意精度），
// 每字符格 = 一个背景色像素，完全不依赖字形（历史 ASCII 图在 cmd 经典字体下
// 因宽字符/缺字形错位的问题就此根除）；配色跟随主题 primary（紫）/accent（金）。
//
// 像素行协议：PixelRow = 若干 (bg 色, 格数) 游程；bg 为空串 = 透明（露出终端底色）。
export interface PixelRun {
  bg: string
  n: number
}

export type PixelRow = PixelRun[]

// 徽标全宽（黑洞环）；字标宽 = 7 字形 × (5 宽 + 1 间隔) − 1 尾间隔
export const PIXEL_LOGO_WIDTH = 46
export const PIXEL_WORDMARK_WIDTH = 41
const RING_H = 12

const mergeRun = (runs: PixelRun[], bg: string, n: number) => {
  if (n <= 0) return
  const last = runs[runs.length - 1]
  if (last && last.bg === bg) last.n += n
  else runs.push({ bg, n })
}

// 黑洞环着色器：d = 椭圆距离；光照左上高光 → 右下暗部
const ringRow = (y: number, c: ThemeColors): PixelRun[] => {
  const cy = (RING_H - 1) / 2
  const cx = (PIXEL_LOGO_WIDTH - 1) / 2
  const ry = (RING_H - 1) / 2
  const rx = (PIXEL_LOGO_WIDTH - 1) / 2

  const photon = mix(c.accent, '#ffffff', 0.3)
  const goldDeep = mix(c.accent, '#6b4a00', 0.45)
  const purpleBright = mix(c.primary, '#ffffff', 0.22)
  const purpleDeep = mix(c.primary, '#150a30', 0.5)
  const shadow = mix(c.primary, '#000000', 0.72)
  const glow = mix(c.primary, '#000000', 0.86)

  const runs: PixelRun[] = []

  for (let x = 0; x < PIXEL_LOGO_WIDTH; x++) {
    const dx = (x - cx) / rx
    const dy = (y - cy) / ry
    const d = dx * dx + dy * dy
    const l = Math.max(-1, Math.min(1, -(dx + dy) / Math.SQRT2))

    // 环带分层：中心洞 → 内阴影 → 光子环（金）→ 环体（紫）→ 暗缘 → 外晕
    let bg = ''
    if (d < 0.44) bg = ''
    else if (d < 0.48) bg = shadow
    else if (d < 0.6) bg = mix(photon, goldDeep, (1 - l) * 0.7)
    else if (d < 0.92) bg = mix(purpleBright, purpleDeep, (1 - l) * 0.8)
    else if (d < 1.02) bg = mix(c.primary, purpleDeep, (1 - l) * 0.6 + 0.2)
    else if (d < 1.24) bg = glow

    mergeRun(runs, bg, 1)
  }

  return runs
}

// 像素字标：5×5 手写字形（'#' 点亮），WXNODUS 金紫交替，O 中心 = 金核奇点
const FONT: Record<string, string[]> = {
  W: ['#...#', '#...#', '#.#.#', '#.#.#', '#####'],
  X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  O: ['.###.', '#...#', '#.#.#', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '####.'],
  U: ['#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '.###.', '....#', '####.'],
}

const WORDMARK = 'WXNODUS'

export const pixelWordmark = (c: ThemeColors): PixelRow[] => {
  const rows: PixelRow[] = []

  for (let r = 0; r < 5; r++) {
    const runs: PixelRow = []

    WORDMARK.split('').forEach((ch, gi) => {
      const glyph = FONT[ch]!

      for (let x = 0; x < 5; x++) {
        if (glyph[r]![x] !== '#') {
          mergeRun(runs, '', 1)
          continue
        }

        const isGold = gi % 2 === 0
        const cell = ch === 'O' && r === 2 && x === 2 ? c.accent : isGold ? c.accent : c.primary
        mergeRun(runs, cell, 1)
      }

      if (gi < WORDMARK.length - 1) mergeRun(runs, '', 1)
    })

    rows.push(runs)
  }

  return rows
}

// 完整徽标：黑洞环 + 空行 + 居中字标（同一宽度坐标系，逐行居中渲染即整图居中）
export const pixelLogo = (c: ThemeColors): PixelRow[] => {
  const ring: PixelRow[] = Array.from({ length: RING_H }, (_, y) => ringRow(y, c))
  const mark = pixelWordmark(c)
  const pad = Math.floor((PIXEL_LOGO_WIDTH - PIXEL_WORDMARK_WIDTH) / 2)

  return [
    ...ring,
    [{ bg: '', n: PIXEL_LOGO_WIDTH }],
    // 左右补齐到全宽——字标与环共享同一居中轴；pad 经 mergeRun 并入（字形边缘
    // 透明格与间隔透明格相邻时不产生未合并游程）
    ...mark.map(row => {
      const full: PixelRow = []
      mergeRun(full, '', pad)
      for (const run of row) mergeRun(full, run.bg, run.n)
      mergeRun(full, '', PIXEL_LOGO_WIDTH - PIXEL_WORDMARK_WIDTH - pad)
      return full
    }),
  ]
}

// 自定义皮肤 logo（settings 皮肤注入）：沿用富文本行渲染（[#hex]…[/] 标记）；
// 默认路径由 pixelLogo 承担，此处仅作皮肤兼容出口。
export const logo = (_c: ThemeColors, customLogo?: string): Line[] =>
  customLogo ? parseRichMarkup(customLogo) : []

export const artWidth = (lines: Line[]) => lines.reduce((m, [, t]) => Math.max(m, t.length), 0)

type Line = [string, string]
