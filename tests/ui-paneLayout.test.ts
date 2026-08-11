// tests/ui-paneLayout.test.ts — A23 双栏布局宽度分配（纯函数）
import { describe, expect, it } from 'vitest'

import { dualPaneWidths, isPaneTab, PANE_MIN_COLS, PANE_TABS } from '../src/wxnodus-ui/lib/paneLayout.js'

describe('dualPaneWidths — 双栏宽度分配', () => {
  it('过窄终端（< 110 列）不渲染面板，对话区占满', () => {
    const w = dualPaneWidths(80)

    expect(w.show).toBe(false)
    expect(w.right).toBe(0)
    expect(w.left).toBe(80)
  })

  it('足够宽时面板启用：right = clamp(cols/3, 30, 46)，left 扣除边框', () => {
    const w = dualPaneWidths(120)

    expect(w.show).toBe(true)
    expect(w.right).toBe(40) // 120/3
    expect(w.left).toBe(120 - 40 - 2) // 扣除面板左右边框
  })

  it('right 宽度下限 30（超宽屏 1/3 也不过大）', () => {
    const w = dualPaneWidths(220)

    expect(w.show).toBe(true)
    expect(w.right).toBe(46) // clamp 上限
    expect(w.left).toBe(220 - 46 - 2)
  })

  it('right 宽度下限 30（窄屏下 1/3 不足时保底）', () => {
    const w = dualPaneWidths(110)

    expect(w.show).toBe(true)
    expect(w.right).toBeGreaterThanOrEqual(30)
    expect(w.left).toBeGreaterThan(0)
  })

  it('边界：恰好 110 列启用', () => {
    expect(dualPaneWidths(PANE_MIN_COLS).show).toBe(true)
    expect(dualPaneWidths(PANE_MIN_COLS - 1).show).toBe(false)
  })
})

describe('isPaneTab / PANE_TABS', () => {
  it('四标签合法，非法值拒绝', () => {
    expect(PANE_TABS).toEqual(['todo', 'tools', 'context', 'subagents'])
    for (const t of PANE_TABS) expect(isPaneTab(t)).toBe(true)
    expect(isPaneTab('nope')).toBe(false)
    expect(isPaneTab(undefined)).toBe(false)
    expect(isPaneTab(42)).toBe(false)
  })
})
