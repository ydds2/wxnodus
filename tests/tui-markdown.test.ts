// tests/tui-markdown.test.ts — Markdown-lite 行渲染：块落屏 + 行内染色 + diff 两遍判定（原型 01/25/54）
import { describe, expect, it } from 'vitest'
import { renderMarkdownLite } from '../src/tui/markdown.js'

describe('块级结构（原型 25 输出全谱）', () => {
  it('标题 → accent 粗体并去 # 前缀', () => {
    const lines = renderMarkdownLite('# 依赖审计报告', 40)
    expect(lines[0]!.kind).toBe('header')
    expect(lines[0]!.segs[0]!.text).toBe('依赖审计报告')
    expect(lines[0]!.segs[0]!.bold).toBe(true)
  })

  it('引用 → │ 前缀 + 原意保留', () => {
    const lines = renderMarkdownLite('> 审计口径：npm audit', 40)
    expect(lines[0]!.kind).toBe('quote')
    expect(lines[0]!.segs[0]!.text).toBe('│ ')
    expect(lines[0]!.segs.map(s => s.text).join('')).toContain('审计口径')
  })

  it('列表项目符保留（- 与 1. 两族）', () => {
    const lines = renderMarkdownLite('- 升级 esbuild\n1. 第一项', 40)
    expect(lines[0]!.segs.map(s => s.text).join('')).toContain('·')
    expect(lines[0]!.segs.map(s => s.text).join('')).toContain('升级 esbuild')
    expect(lines[1]!.segs.map(s => s.text).join('')).toContain('1.')
  })

  it('围栏：内容不解析行内、不染色，未闭合诚实收口', () => {
    const lines = renderMarkdownLite('```ts\nconst a = **not bold**\n```', 40)
    expect(lines[0]!.kind).toBe('fence')
    expect(lines[1]!.kind).toBe('fence')
    expect(lines[1]!.segs[0]!.text).toBe('const a = **not bold**')
    expect(lines[2]!.kind).toBe('fence-end')
    const unclosed = renderMarkdownLite('```ts\nx', 40)
    expect(unclosed.at(-1)!.kind).toBe('fence-end')
  })

  it('未闭合行内标记不崩（块提交模式——半个标记安全丢弃）', () => {
    const lines = renderMarkdownLite('文本 **半截', 40)
    expect(lines[0]!.segs.map(s => s.text).join('')).toBe('文本 **半截')
  })
})

describe('行内染色（粗体/行内代码）', () => {
  it('**粗体** → bold 段', () => {
    const lines = renderMarkdownLite('整体 **健康**', 40)
    const bold = lines[0]!.segs.find(s => s.bold)
    expect(bold?.text).toBe('健康')
  })

  it('`代码` → accent 段', () => {
    const lines = renderMarkdownLite('调用 `relTime()` 完成', 40)
    const code = lines[0]!.segs.find(s => s.code)
    expect(code?.text).toBe('relTime()')
  })
})

describe('diff 红绿染色（原型 01/54 —— 两遍判定防误伤）', () => {
  it('有 hunk 头 → +绿/-红/@@青', () => {
    const text = '@@ -1,3 +1,3 @@\n+ export function relTime() {\n-   return now\n+   return rel\n'
    const lines = renderMarkdownLite(text, 60)
    expect(lines[0]!.kind).toBe('diff-hunk')
    expect(lines.find(l => l.kind === 'diff-add')).toBeTruthy()
    expect(lines.find(l => l.kind === 'diff-del')).toBeTruthy()
  })

  it('连续 ± 候选 ≥2 → 判定为 diff（无 hunk 头也染）', () => {
    const lines = renderMarkdownLite('+ aaa\n+ bbb\n- ccc', 60)
    expect(lines[0]!.kind).toBe('diff-add')
    expect(lines[2]!.kind).toBe('diff-del')
  })

  it('孤立 - 开头列表项不误判为 diff', () => {
    const lines = renderMarkdownLite('- 升级 esbuild', 60)
    expect(lines[0]!.kind).toBe('normal')
    expect(lines[0]!.segs.some(s => s.color === 'red')).toBe(false)
  })

  it('---/+++ 元信息行 dim', () => {
    const lines = renderMarkdownLite('--- a/x.ts\n+++ b/x.ts\n+ y', 60)
    expect(lines[0]!.kind).toBe('diff-meta')
    expect(lines[1]!.kind).toBe('diff-meta')
  })
})
