// tests/vim-visual.test.ts — P3 增量：vim VISUAL 模式（codex textarea/vim.rs 对标；gemini vim.ts 无）
import { describe, expect, it } from 'vitest'
import { initialVimState, vimHandleKey } from '../src/wxnodus-ui/lib/vimCore.js'

const run = (keys: string[], text: string, cursor = 0, register = '') => {
  let st = initialVimState()
  let doc = { text, cursor }
  let reg = register
  let yanked: string | null = null
  for (const k of keys) {
    const r = vimHandleKey(st, doc, k, Date.now(), reg)
    st = r.state
    doc = r.doc
    if (r.yanked) { yanked = r.yanked; reg = r.yanked }
  }
  return { st, doc, yanked }
}

describe('vim VISUAL 模式（v/V）', () => {
  it('v 进入字符选区 → 移动扩展选区 → d 删除选区回 normal', () => {
    const r = run(['Escape', 'v', 'l', 'l', 'd'], 'abcde', 0)
    expect(r.st.mode).toBe('normal')
    expect(r.doc.text).toBe('de')
    expect(r.yanked).toBe('abc')
  })

  it('y 复制选区不动文本；c 改选区进 insert', () => {
    const y = run(['Escape', 'v', 'l', 'l', 'y'], 'abcde', 0)
    expect(y.doc.text).toBe('abcde')
    expect(y.yanked).toBe('abc')
    const c = run(['Escape', 'v', 'l', 'l', 'c'], 'abcde', 0)
    expect(c.st.mode).toBe('insert')
    expect(c.doc.text).toBe('de')
  })

  it('V 行选区：跨行删除整行（含换行）', () => {
    const r = run(['Escape', 'V', 'j', 'd'], 'a\nb\nc', 0)
    expect(r.doc.text).toBe('c')
    expect(r.yanked).toBe('a\nb\n')
  })

  it('选区 p 粘贴替换选区；x 等同 d', () => {
    const p = run(['Escape', 'y', 'y', 'G', 'v', '0', 'p'], 'ab\ncd', 0)
    // yy 复制首行 → 光标到文末 → v0 选中第二行 → p 替换
    expect(p.doc.text).toBe('ab\nab\n')
    const x = run(['Escape', 'v', 'l', 'x'], 'abcd', 0)
    expect(x.doc.text).toBe('cd') // v 选 [0,1) + l 扩展 [0,2) → x 删选区（vim 语义）
  })

  it('Esc 退出 visual 保留光标（不清选区外内容）', () => {
    const r = run(['Escape', 'v', 'l', 'l', 'Escape', 'x'], 'abcde', 0)
    expect(r.st.mode).toBe('normal')
    expect(r.doc.text).toBe('abde') // Esc 保留光标 2 不清选区外内容，x 删光标处 'c'
  })

  it('反向选区（锚点在前移动向左）删除同样生效', () => {
    const r = run(['Escape', '$', 'v', 'h', 'h', 'd'], 'abcde', 0)
    expect(r.yanked).toBe('cde')
    expect(r.doc.text).toBe('ab')
  })
})
