// src/wxnodus-ui/lib/brandRule.test.ts — 品牌差异化布局纯函数（吸积盘分隔线 + 常驻顶栏布局）
import { describe, expect, it } from 'vitest'
import { accretionRule, brandBarLayout, BLACKHOLE_CORE } from './brandRule.js'

const colors = { border: '#26A69A', accent: '#B388FF', primary: '#00E5FF' }

describe('accretionRule 吸积盘分隔线', () => {
  it('degenerates to the bare event-horizon core on a one-column width', () => {
    expect(accretionRule(1, colors)).toEqual([{ color: colors.primary, text: BLACKHOLE_CORE }])
  })

  it('mirrors the ring gradient around the core with the accent ring innermost', () => {
    const segments = accretionRule(9, colors)
    const text = segments.map(s => s.text).join('')
    expect(text).toHaveLength(9)
    expect(text[4]).toBe(BLACKHOLE_CORE)
    // 中心两侧最近的是内环（accent）
    expect(segments.find(s => s.text.includes('─') && s.color === colors.accent)).toBeDefined()
    expect(segments[0]!.color).toBe(colors.border)
    expect(segments.at(-1)!.color).toBe(colors.border)
  })

  it('caps the inner accent ring so wide rules stay predominantly border', () => {
    const segments = accretionRule(80, colors)
    const accentWidth = segments.filter(s => s.color === colors.accent).reduce((n, s) => n + s.text.length, 0)
    expect(accentWidth).toBeLessThanOrEqual(8)
    expect(segments.map(s => s.text).join('')).toHaveLength(80)
  })

  it('never emits segments beyond the requested width', () => {
    for (const width of [0, 1, 2, 3, 5, 17, 40]) {
      const total = accretionRule(width, colors).reduce((n, s) => n + s.text.length, 0)
      expect(total).toBe(width)
    }
  })
})

describe('brandBarLayout 常驻品牌顶栏', () => {
  it('returns null below the minimum width', () => {
    expect(brandBarLayout(23, { name: 'WxNodus V3', icon: '◉' }, 'deepseek')).toBeNull()
  })

  it('reserves a bounded left brand and right context around a flexible rule', () => {
    const layout = brandBarLayout(100, { name: 'WxNodus V3', icon: '◉' }, 'deepseek v4 · local')
    expect(layout).not.toBeNull()
    if (!layout) throw new Error('unreachable')
    expect(layout.left).toBe('◉ WxNodus V3')
    expect(layout.right).toBe('deepseek v4 · local')
    expect(layout.ruleWidth).toBeGreaterThanOrEqual(8)
    expect(layout.left.length + layout.ruleWidth + layout.right.length).toBeLessThanOrEqual(100)
  })

  it('truncates long names and labels instead of overflowing', () => {
    const layout = brandBarLayout(60, { name: 'WxNodus V3 本地概念编译器旗舰版', icon: '◉' }, 'deepseek-v4-pro-with-very-long-suffix')
    expect(layout).not.toBeNull()
    if (!layout) throw new Error('unreachable')
    expect(layout.left.length).toBeLessThanOrEqual(Math.floor(60 * 0.35) + 2)
    expect(layout.right.length).toBeLessThanOrEqual(Math.floor(60 * 0.3) + 2)
    expect(layout.left.endsWith('…') || layout.left.length <= Math.floor(60 * 0.35) + 2).toBe(true)
    expect(layout.ruleWidth).toBeGreaterThanOrEqual(1)
  })

  it('drops the context label entirely on the narrowest supported width', () => {
    const layout = brandBarLayout(26, { name: 'WxNodus V3', icon: '◉' }, 'deepseek')
    expect(layout).not.toBeNull()
    if (!layout) throw new Error('unreachable')
    expect(layout.right).toBe('')
    expect(layout.ruleWidth).toBeGreaterThanOrEqual(1)
  })
})
