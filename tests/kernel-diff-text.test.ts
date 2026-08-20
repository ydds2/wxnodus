// tests/kernel-diff-text.test.ts — ③ 波 1：fs_edit 结果 diff 块生成（上限纪律 + 头格式）
import { describe, expect, it } from 'vitest'
import { renderUnifiedDiff, MAX_DIFF_LINES, MAX_LINE_CHARS } from '../src/kernel/diffText.js'

describe('renderUnifiedDiff（fs_edit 结果 diff 回显体）', () => {
  it('@@ 头 + 上下文 + -/+ 行', () => {
    const d = renderUnifiedDiff({ newLine: 3, oldText: 'old line', newText: 'new line', before: 'const a = 1;', after: 'const b = 2;' })
    expect(d.split('\n')[0]).toBe('@@ -3,1 +3,1 @@')
    expect(d).toContain(' const a = 1;')
    expect(d).toContain('-old line')
    expect(d).toContain('+new line')
    expect(d).toContain(' const b = 2;')
  })

  it('多行替换：行数正确进 @@ 头；空上下文不产生空行', () => {
    const d = renderUnifiedDiff({ newLine: 10, oldText: 'a\nb\nc', newText: 'x\ny', before: '', after: '' })
    expect(d.split('\n')[0]).toBe('@@ -10,3 +10,2 @@')
    expect(d.split('\n').filter(l => l.startsWith('-')).length).toBe(3)
    expect(d.split('\n').filter(l => l.startsWith('+')).length).toBe(2)
  })

  it('超限截断显式标注（绝不静默丢行）', () => {
    const many = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `line${i}`).join('\n')
    const d = renderUnifiedDiff({ newLine: 1, oldText: many, newText: 'one', before: '', after: '' })
    expect(d.split('\n').filter(l => l.startsWith('-')).length).toBe(MAX_DIFF_LINES)
    expect(d).toContain('…（5 行省略）')
  })

  it('超长单行截断带 … 标记', () => {
    const long = 'x'.repeat(MAX_LINE_CHARS + 30)
    const d = renderUnifiedDiff({ newLine: 1, oldText: long, newText: 'y', before: '', after: '' })
    const minus = d.split('\n').find(l => l.startsWith('-'))!
    expect(minus.length).toBe(1 + MAX_LINE_CHARS + 1) // '-' + 120 字 + '…'
    expect(minus.endsWith('…')).toBe(true)
  })

  it('CRLF 输入剥离（Windows 文件换行不污染 diff 行）', () => {
    const d = renderUnifiedDiff({ newLine: 2, oldText: 'a\r\nb', newText: 'c', before: '', after: '' })
    expect(d).not.toContain('\r')
    expect(d.split('\n')[0]).toBe('@@ -2,2 +2,1 @@')
  })
})
