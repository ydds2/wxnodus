// tests/vim-textobject.test.ts — P3 评估轮：vim 文本对象 di(/da"/ciw/yi{（codex vim.rs:229-264 括号栈对标）
// 六家唯一对标：codex 有括号栈文本对象（VimMode 无 VISUAL），本文件覆盖对象区间纯函数 + 操作符/选区接线
import { describe, expect, it } from 'vitest'
import { initialVimState, textObjectRange, vimHandleKey } from '../src/wxnodus-ui/lib/vimCore.js'

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

describe('textObjectRange 纯函数', () => {
  it('i(/a( 内/外区间；光标在开括号上也算在内', () => {
    expect(textObjectRange('foo(bar)baz', 5, 'i', '(')).toEqual([4, 7])
    expect(textObjectRange('foo(bar)baz', 5, 'a', '(')).toEqual([3, 8])
    expect(textObjectRange('foo(bar)baz', 3, 'i', '(')).toEqual([4, 7]) // 光标在 '(' 上
  })
  it('嵌套：取最近一层（codex 深度计数）', () => {
    expect(textObjectRange('a(b(c)d)e', 4, 'i', '(')).toEqual([4, 5])
    expect(textObjectRange('a(b(c)d)e', 2, 'i', '(')).toEqual([2, 7])
    expect(textObjectRange('a(b(c)d)e', 2, 'a', '(')).toEqual([1, 8])
  })
  it('闭括号对象 di)/da} 同样有效', () => {
    expect(textObjectRange('a(b(c)d)e', 6, 'i', ')')).toEqual([2, 7])
    expect(textObjectRange('x{y}z', 3, 'a', '}')).toEqual([1, 4])
  })
  it('引号对象 i"/a"（同行）', () => {
    expect(textObjectRange('say "hi" now', 5, 'i', '"')).toEqual([5, 7])
    expect(textObjectRange('say "hi" now', 5, 'a', '"')).toEqual([4, 8])
  })
  it('行内多对引号：取最小包围候选（codex 最小包围对标）', () => {
    // 光标在第二对 → 选第二对（此前实现 c<open||c>close 直接 null）
    expect(textObjectRange('a "one" b "two" c', 12, 'i', '"')).toEqual([11, 14])
    expect(textObjectRange('a "one" b "two" c', 12, 'a', '"')).toEqual([10, 15])
    // 光标在第一对 → 仍第一对
    expect(textObjectRange('a "one" b "two" c', 4, 'i', '"')).toEqual([3, 6])
  })
  it('转义引号不算定界符（codex is_escaped 对标）', () => {
    // \" 为转义字面——光标在外层引号内容中 → 外层整段
    expect(textObjectRange('say "a \\"b\\" c" now', 6, 'i', '"')).toEqual([5, 14])
    // 光标在转义引号本体上：仍属外层引号内容 → 同样选外层（vim 语义）
    expect(textObjectRange('say "a \\"b\\" c" now', 8, 'i', '"')).toEqual([5, 14])
    // 光标在引号对外（y 上）→ null（诚实失败）
    expect(textObjectRange('say "a \\"b\\" c" now', 2, 'i', '"')).toBeNull()
    // 单引号同样转义感知
    expect(textObjectRange("x 'a \\'b\\' c' y", 7, 'i', "'")).toEqual([3, 12])
  })
  it('反引号对象（codex 八种之八——七评补全后 8/8 全覆盖）', () => {
    expect(textObjectRange('x`hi`y', 3, 'i', '`')).toEqual([2, 4])
    expect(textObjectRange('x`hi`y', 3, 'a', '`')).toEqual([1, 5])
    const d = run(['Escape', 'd', 'i', '`'], 'x`hi`y', 3)
    expect(d.doc.text).toBe('x``y')
    expect(d.yanked).toBe('hi')
  })
  it('词对象 iw/aw', () => {
    expect(textObjectRange('foo bar', 1, 'i', 'w')).toEqual([0, 3])
    expect(textObjectRange('foo bar', 0, 'a', 'w')).toEqual([0, 4])
    expect(textObjectRange('foo bar', 3, 'i', 'w')).toEqual([3, 4]) // 光标在空白→空白串本身（vim 语义）
  })
  it('语法感知：字符串里的括号不算括号（codex is_inside_element 对标）', () => {
    // 光标在 say 后：括号对象应跳过 "a (b" 里的 ( 而选外层调用括号
    expect(textObjectRange('say("a (b")', 3, 'i', '(')).toEqual([4, 10])
    expect(textObjectRange('x = f("]") + g', 8, 'i', ']')).toBeNull() // 字符串里的 ] 不是真闭括号
    // 字符串外正常语义不受影响
    expect(textObjectRange('foo(bar)', 5, 'i', '(')).toEqual([4, 7])
  })
  it('无效对象 → null', () => {
    expect(textObjectRange('abc', 1, 'i', '(')).toBeNull()
    expect(textObjectRange('abc', 1, 'i', 'q')).toBeNull()
  })
})

describe('操作符 + 文本对象（di(/da(/ci(/yi(）', () => {
  it('di( 删内层回 normal；da( 含括号；yi( 复制不动文本', () => {
    const d = run(['Escape', 'd', 'i', '('], 'foo(bar)baz', 5)
    expect(d.doc.text).toBe('foo()baz')
    expect(d.yanked).toBe('bar')
    expect(d.st.mode).toBe('normal')
    const a = run(['Escape', 'd', 'a', '('], 'foo(bar)baz', 5)
    expect(a.doc.text).toBe('foobaz')
    expect(a.yanked).toBe('(bar)')
    const y = run(['Escape', 'y', 'i', '{'], 'x{y}z', 2)
    expect(y.doc.text).toBe('x{y}z')
    expect(y.yanked).toBe('y')
  })
  it('ci( 改内层进 insert；ciw 改词', () => {
    const c = run(['Escape', 'c', 'i', '('], 'foo(bar)baz', 5)
    expect(c.doc.text).toBe('foo()baz')
    expect(c.st.mode).toBe('insert')
    const w = run(['Escape', 'c', 'i', 'w'], 'foo bar', 1)
    expect(w.doc.text).toBe(' bar')
    expect(w.st.mode).toBe('insert')
  })
  it('嵌套取最近层：di( 只删内层内容', () => {
    const r = run(['Escape', 'd', 'i', '('], 'a(b(c)d)e', 4)
    expect(r.doc.text).toBe('a(b()d)e')
    expect(r.yanked).toBe('c')
  })
  it('无效对象键 → 取消操作符且不改文本', () => {
    const r = run(['Escape', 'd', 'i', 'q'], 'foo(bar)baz', 5)
    expect(r.doc.text).toBe('foo(bar)baz')
    expect(r.st.pendingOp).toBeNull()
  })
  it('di" 删引号内容；daw 词 + 尾随空白', () => {
    const q = run(['Escape', 'd', 'i', '"'], 'say "hi" now', 5)
    expect(q.doc.text).toBe('say "" now')
    expect(q.yanked).toBe('hi')
    const w = run(['Escape', 'd', 'a', 'w'], 'foo bar baz', 0)
    expect(w.doc.text).toBe('bar baz')
    expect(w.yanked).toBe('foo ')
  })
})

describe('VISUAL + 文本对象（vi(/va" 选区）', () => {
  it('vi( 选区覆盖对象 → d 删除对象', () => {
    const r = run(['Escape', 'v', 'i', '(', 'd'], 'foo(bar)baz', 5)
    expect(r.doc.text).toBe('foo()baz')
    expect(r.yanked).toBe('bar')
  })
  it('va" 含定界符选区 → c 进 insert', () => {
    const r = run(['Escape', 'v', 'a', '"', 'c'], 'say "hi" now', 5)
    expect(r.doc.text).toBe('say  now')
    expect(r.st.mode).toBe('insert')
  })
})
