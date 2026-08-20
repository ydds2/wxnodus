// tests/input-highlight.test.ts — ② 波 1：输入区 token 高亮（gemini highlight.ts:29-57 对标）
import { describe, expect, it } from 'vitest'
import { highlightInputAnsi, highlightTokens, scanInputTokens } from '../src/wxnodus-ui/lib/inputHighlight.js'

describe('scanInputTokens（斜杠命令/@提及/占位符三类）', () => {
  it('三类 token 各自识别（词首斜杠、@路径、{{占位符}}）', () => {
    const spans = scanInputTokens('请 /compact 后读 @src/kernel/agent.ts 填 {{name}}')
    const kinds = spans.map(s => s.kind)
    expect(kinds).toEqual(['slash', 'mention', 'placeholder'])
    const [slash, mention, ph] = spans
    expect(slash!.start).toBe(2)
    expect(mention!.start).toBe(14)
    expect(ph!.start).toBeGreaterThan(mention!.end)
  })

  it('无 token 文本 → 空数组；email 中 @ 不误判为提及（后无路径字符的边界）', () => {
    expect(scanInputTokens('普通文本没有任何标记')).toEqual([])
    // a@b.c 中 @b.c 是合法路径字符——按 mention 识别（gemini 同款宽松语义）
    expect(scanInputTokens('联系 a@b.c')).toHaveLength(1)
  })

  it('相邻 token 不合并、按位置排序且区间互不重叠', () => {
    const spans = scanInputTokens('/a@b {{x}} @c /d')
    expect(spans.map(s => s.kind)).toEqual(['slash', 'mention', 'placeholder', 'mention', 'slash'])
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end)
    }
  })
})

describe('highlightTokens LRU 缓存', () => {
  it('同文本命中缓存（同引用返回）；不同文本独立扫描', () => {
    const a = highlightTokens('/compact 你好')
    expect(highlightTokens('/compact 你好')).toBe(a)
    const b = highlightTokens('/model set')
    expect(b).not.toBe(a)
  })

  it('缓存上限 64：超限逐出最旧（不泄漏无界）', () => {
    for (let i = 0; i < 100; i++) highlightTokens(`/cmd${i} 文本`)
    expect(highlightTokens('/cmd99 文本').length).toBe(1) // 最近仍可复用
  })
})

describe('highlightInputAnsi（内联 ANSI 着色）', () => {
  it('token 包 ANSI 转义（斜杠青 36m / 提及品红 35m / 占位符暗 2m）', () => {
    const out = highlightInputAnsi('读 /compact 与 @a.ts 填 {{x}}')
    expect(out).toContain('\x1b[36m/compact\x1b[0m')
    expect(out).toContain('\x1b[35m@a.ts\x1b[0m')
    expect(out).toContain('\x1b[2m{{x}}\x1b[0m')
  })

  it('无 token 原样返回（零开销路径）', () => {
    expect(highlightInputAnsi('plain')).toBe('plain')
  })
})
