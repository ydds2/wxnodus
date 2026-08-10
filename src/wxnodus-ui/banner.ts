import type { ThemeColors } from './theme.js'

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

const LOGO_ART = [
  '██╗    ██╗ ██╗  ██╗ ███╗   ██╗  ██████╗  ██████╗  ██╗   ██╗ ███████╗',
  '██╗  ██║ ╚██╗██╔╝ ████╗  ██║ ██╔═══██╗ ██╔══██╗ ██║   ██║ ██╔════╝',
  '██╚██╔██║  ╚███╔╝  ██╔██╗ ██║ ██║   ██║ ██║  ██║ ██║   ██║ ███████╗',
  '██║╚═╝██║  ██╔██╗  ██║╚██╗██║ ██║   ██║ ██║  ██║ ██║   ██║ ╚════██║',
  '╚═╝  ╚═╝ ╚═╝ ╚═╝ ██║ ╚████║ ╚██████╔╝ ██████╔╝ ╚██████╔╝ ███████║',
  '                    ╚═╝  ╚═══╝  ╚═════╝  ╚═════╝   ╚═════╝  ╚══════╝',
]

// WxNodus 品牌徽标（差异化）：黑洞视界剖面——吸积盘同心环
// 概念来源：黑洞引擎（black-hole memory：三层记忆 + 吸附 + 混合召回）
const BLACKHOLE_ART = [
  '      ⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀',
  '   ⣀⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⣀',
  '  ⣀⠔⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠔⣀',
  ' ⣀⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⣀',
  ' ⣀⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⣀',
  ' ⣀⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⣀',
  '  ⣀⠔⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠔⣀',
  '   ⣀⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⣀',
  '      ⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀',
]

const LOGO_GRADIENT = [0, 0, 1, 1, 2, 2] as const
// 吸积盘光照：上方亮弧（primary）→ 中部环（accent/border）→ 底部暗（muted）
const HERO_GRADIENT = [0, 1, 1, 2, 2, 2, 1, 1, 0] as const

const colorize = (art: string[], gradient: readonly number[], c: ThemeColors): Line[] => {
  const p = [c.primary, c.accent, c.border, c.muted]

  return art.map((text, i) => [p[gradient[i]!] ?? c.muted, text])
}

export const LOGO_WIDTH = Math.max(...LOGO_ART.map(line => line.length))
export const HERO_WIDTH = Math.max(...BLACKHOLE_ART.map(line => line.length))

export const logo = (c: ThemeColors, customLogo?: string): Line[] =>
  customLogo ? parseRichMarkup(customLogo) : colorize(LOGO_ART, LOGO_GRADIENT, c)

export const hero = (c: ThemeColors, customHero?: string): Line[] =>
  customHero ? parseRichMarkup(customHero) : colorize(BLACKHOLE_ART, HERO_GRADIENT, c)

export const artWidth = (lines: Line[]) => lines.reduce((m, [, t]) => Math.max(m, t.length), 0)

type Line = [string, string]
