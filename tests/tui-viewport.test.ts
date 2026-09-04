// tests/tui-viewport.test.ts — 钉底视口纯函数：CJK 宽度 / 硬换行 / 条目切片 / 行数预算
import { describe, expect, it } from 'vitest'
import { charWidth, strWidth, wrapText, sliceViewport, sliceViewportFromTop, transcriptBudget, rowsOfText } from '../src/tui/viewport.js'

describe('wrapText 词感知换行（ⅩⅩⅧ：URL/路径/命令参数不硬切两半）', () => {
  it('长 URL 在词边界换行——不切成 ...registry. / npmmirror.com 两半', () => {
    const text = '执行：npm install better-sqlite3@12.11.1 --registry=https://registry.npmmirror.com --omit=dev'
    const lines = wrapText(text, 44)  // URL token 41 宽——44 可整词换行
    const joined = lines.join('\n')
    expect(joined).toContain('https://registry.npmmirror.com')
    expect(lines.some(l => /registry\.$/.test(l.trimEnd()))).toBe(false)
    for (const l of lines) expect(strWidth(l)).toBeLessThanOrEqual(44)
  })

  it('路径不被切成两半（...packag / e.json 形态禁止）', () => {
    const text = '配置文件位于 C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + '20164' + String.fromCharCode(92) + 'Desktop' + String.fromCharCode(92) + 'wxnodus4.0' + String.fromCharCode(92) + 'package.json 附近'
    const lines = wrapText(text, 48)  // 路径 token 43 宽——48 可整词换行
    const flat = lines.join('|')
    expect(flat).toContain('package.json')
    expect(flat).not.toMatch(/packag\|e\.json/)
  })

  it('超行宽长串仍硬切（可见性优先）+ CJK 自然断点不变', () => {
    const long = 'a'.repeat(50)
    const lines = wrapText(`说明 ${long}`, 10)
    expect(lines.length).toBeGreaterThanOrEqual(6)
    for (const l of lines) expect(strWidth(l)).toBeLessThanOrEqual(10)
    const zh = wrapText('中文每个字都是自然断点测试', 6)
    for (const l of zh) expect(strWidth(l)).toBeLessThanOrEqual(6)
  })
})

describe('CJK 宽度感知（conhost 显示 2 列）', () => {
  it('宽字符 2 列 · 组合标记 0 列 · ASCII 1 列', () => {
    expect(charWidth('你')).toBe(2)
    expect(charWidth('a')).toBe(1)
    expect(charWidth('▎')).toBe(2)
    expect(strWidth('你好ab')).toBe(6)
  })

  it('硬换行按显示宽度断行（长行不靠 ink wrap——行数可预测）', () => {
    const lines = wrapText('abcdefgh', 4)
    expect(lines).toEqual(['abcd', 'efgh'])
    const cjk = wrapText('你好世界', 4)
    expect(cjk).toEqual(['你好', '世界'])
  })

  it('多段落保留空行', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })
})

describe('sliceViewport 条目钳制', () => {
  const entries = ['a', 'bb', 'ccc', 'dddd', 'eeeee'] // 1/1/1/1/1 行
  const rowsOf = (_e: string) => 1

  it('贴底（offset 0）：只保留尾部 budget 条', () => {
    const v = sliceViewport(entries, rowsOf, 2, 0)
    expect(v.items.map(i => i.entry)).toEqual(['dddd', 'eeeee'])
    expect(v.hiddenAbove).toBe(3)
    expect(v.hiddenBelow).toBe(0)
  })

  it('翻页（offset 2）：视口上移，下方出现隐藏计数', () => {
    const v = sliceViewport(entries, rowsOf, 2, 2)
    expect(v.items.map(i => i.entry)).toEqual(['bb', 'ccc'])
    expect(v.hiddenAbove).toBe(1)
    expect(v.hiddenBelow).toBe(2)
  })

  it('超大条目：只渲染尾部行并计入上方隐藏', () => {
    const big = ['x'.repeat(100)] // 1 条 100 行
    const bigRows = (e: string) => (e.length >= 100 ? 100 : 1)
    const v = sliceViewport(big, bigRows, 5, 0)
    expect(v.items).toHaveLength(1)
    expect(v.items[0]!.fromLine).toBe(95)
    expect(v.items[0]!.toLine).toBe(100)
    expect(v.hiddenAbove).toBe(95)
  })

  it('offset 超界：钳制到贴顶（最旧内容入窗，不翻出空窗）', () => {
    const v = sliceViewport(entries, rowsOf, 3, 99)
    expect(v.items.map(i => i.entry)).toEqual(['a', 'bb', 'ccc'])
    expect(v.hiddenAbove).toBe(0)
    expect(v.hiddenBelow).toBeGreaterThan(0)
  })
})

describe('sliceViewportFromTop 顶锚定（上翻阅读视口冻结）', () => {
  const entries = ['a', 'bb', 'ccc', 'dddd', 'eeeee'] // 1/1/1/1/1 行
  const rowsOf = (_e: string) => 1

  it('topLine 0：从最旧内容正向填充（新内容只进 ↓ 计数）', () => {
    const v = sliceViewportFromTop(entries, rowsOf, 2, 0)
    expect(v.items.map(i => i.entry)).toEqual(['a', 'bb'])
    expect(v.hiddenAbove).toBe(0)
    expect(v.hiddenBelow).toBe(3)
  })

  it('topLine 2：视口停在锚点——不受尾部增长影响（冻结语义）', () => {
    const v = sliceViewportFromTop(entries, rowsOf, 2, 2)
    expect(v.items.map(i => i.entry)).toEqual(['ccc', 'dddd'])
    expect(v.hiddenAbove).toBe(2)
    expect(v.hiddenBelow).toBe(1)
    // 尾部追加新条目后锚点不变：视口仍停在 ccc/dddd，下方计数增长
    const grown = [...entries, 'ffffff', 'ggggggg']
    const v2 = sliceViewportFromTop(grown, rowsOf, 2, 2)
    expect(v2.items.map(i => i.entry)).toEqual(['ccc', 'dddd'])
    expect(v2.hiddenBelow).toBe(3)
  })

  it('topLine 超界：返回空窗且上方隐藏钳制为锚点（渲染侧先钳制，此为防御）', () => {
    const v = sliceViewportFromTop(entries, rowsOf, 2, 99)
    expect(v.items).toHaveLength(0)
    expect(v.hiddenBelow).toBe(0)
  })
})

describe('行数预算（钉底）', () => {
  it('转录区 = 终端行 − 固定区，最小 3 行（极端小窗保输入框）', () => {
    expect(transcriptBudget(24, 10)).toBe(14)
    expect(transcriptBudget(10, 30)).toBe(3)
  })

  it('rowsOfText 对空串至少 1 行', () => {
    expect(rowsOfText('', 20)).toBe(1)
  })
})
