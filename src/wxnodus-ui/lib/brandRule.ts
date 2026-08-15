import { icon } from '../glyphs.js'
// src/wxnodus-ui/lib/brandRule.ts — 品牌差异化布局纯函数
// 概念：黑洞引擎——吸积盘分隔线（外缘 border → 内环 accent → 中心事件视界辉光 ◉）；
// 常驻品牌顶栏（左品牌名 + 右上下文 + 中间弹性吸积盘规则线），窄终端渐进收缩。
export interface AccretionSegment {
  color: string
  text: string
}

export interface AccretionColors {
  border: string
  accent: string
  primary: string
}

export const BLACKHOLE_CORE = icon('brand')

const MIN_ACCENT_RING = 1
const MAX_ACCENT_RING = 4

/** 吸积盘分隔线：镜像渐变——border 外缘 → accent 内环 → primary 中心核心，总宽恰为 width。 */
export function accretionRule(width: number, colors: AccretionColors): AccretionSegment[] {
  const w = Math.max(0, Math.floor(width))

  if (w === 0) {
    return []
  }

  if (w === 1) {
    return [{ color: colors.primary, text: BLACKHOLE_CORE }]
  }

  // 内环宽：随宽度增长但封顶（宽终端里外缘占主导，中心辉光不喧宾夺主）
  const ring = Math.min(MAX_ACCENT_RING, Math.max(MIN_ACCENT_RING, Math.floor((w - 1) / 8)))
  const core = BLACKHOLE_CORE.length // 1
  const side = Math.floor((w - core) / 2)
  const ringSide = Math.min(ring, Math.floor(side / 2))
  const borderSide = side - ringSide
  const remainder = w - (borderSide + ringSide) * 2 - core

  return [
    ...(borderSide > 0 ? [{ color: colors.border, text: '─'.repeat(borderSide) }] : []),
    ...(ringSide > 0 ? [{ color: colors.accent, text: '─'.repeat(ringSide) }] : []),
    { color: colors.primary, text: BLACKHOLE_CORE },
    ...(ringSide > 0 ? [{ color: colors.accent, text: '─'.repeat(ringSide) }] : []),
    ...(borderSide + remainder > 0 ? [{ color: colors.border, text: '─'.repeat(borderSide + remainder) }] : []),
  ]
}

export interface BrandBarLayout {
  left: string
  right: string
  ruleWidth: number
}

const clip = (s: string, w: number) =>
  w <= 0 ? '' : s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s

export const BRAND_BAR_MIN_WIDTH = 24

/** 常驻品牌顶栏布局：左品牌（≤35% 宽）+ 右上下文（≤30% 宽）+ 中间弹性规则线；过窄返回 null。 */
export function brandBarLayout(
  cols: number,
  brand: { name: string; icon: string },
  rightLabel: string
): BrandBarLayout | null {
  const w = Math.max(0, Math.floor(cols))

  if (w < BRAND_BAR_MIN_WIDTH) {
    return null
  }

  const leftBudget = Math.floor(w * 0.35)
  const rightBudget = Math.floor(w * 0.3)
  const leftFull = `${brand.icon} ${brand.name}`

  // 窄终端：右侧上下文让位（保留品牌 + 规则线），再窄则截断品牌名
  const keepRight = rightBudget >= 8
  const left = clip(leftFull, keepRight ? leftBudget : Math.min(leftFull.length, w - 2))
  const right = keepRight ? clip(rightLabel, rightBudget) : ''
  const ruleWidth = Math.max(1, w - left.length - right.length - 2)

  return { left, right, ruleWidth }
}
