// tests/kernel-mentions-range.test.ts — 波 2 ② 7→8：@提及行区间（opencode autocomplete.tsx:29-58 对标）
import { describe, expect, it } from 'vitest'
import { expandMentions } from '../src/kernel/mentions.js'

const FILE = 'line1\nline2\nline3\nline4\nline5\n'

const expand = (input: string) =>
  expandMentions(input, {
    cwd: '/tmp',
    readFile: (p: string) => (p.endsWith('f.txt') ? Buffer.from(FILE, 'utf8') : null),
  })

describe('@path#L 行区间展开', () => {
  it('#L2-L4 只取 2-4 行（1-based，含两端）', () => {
    const r = expand('看 @f.txt#L2-L4')
    expect(r.text).toContain('line2\nline3\nline4')
    expect(r.text).not.toContain('line1\n')
    expect(r.text).not.toContain('line5')
    expect(r.mentions[0]!.path).toBe('f.txt#L2-L4') // 展开块保留完整 token（透明度）
  })

  it('#L3 单行区间', () => {
    const r = expand('@f.txt#L3')
    expect(r.text).toContain('line3')
    expect(r.text).not.toContain('line2')
  })

  it('越界区间夹取到文件范围（start>行数 → 空/末行，end>行数 → 文件尾）', () => {
    const r = expand('@f.txt#L4-L99')
    expect(r.text).toContain('line4\nline5') // end 越界 clamp 到末行
    expect(r.text).not.toContain('line1\n')
  })

  it('无 #L 尾巴 → 全文照旧（行为不回归）', () => {
    const r = expand('@f.txt')
    expect(r.text).toContain('line1')
    expect(r.text).toContain('line5')
  })

  it('行区间提及的 bytes 记录为切片字节数（截断判定基于区间而非全文）', () => {
    const r = expand('@f.txt#L1-L1')
    expect(r.mentions[0]!.bytes).toBe(Buffer.from('line1', 'utf8').length)
  })
})
