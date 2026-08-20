// tests/vim-core.test.ts — 波 3 ② 8→9：vim 模态纯核心（gemini vim.ts 状态机 + vim-buffer-actions 纯 reducer 对标）
import { describe, expect, it } from 'vitest'
import { initialVimState, vimHandleKey, type VimCoreState, type VimDoc } from '../src/wxnodus-ui/lib/vimCore.js'

/** 便捷驱动：从 INSERT 起始，按 key 序列逐步解释（含 Esc 进 normal） */
const run = (keys: string[], doc0: VimDoc = { text: 'hello world', cursor: 0 }, register = '') => {
  let st = initialVimState()
  let doc = doc0
  let reg = register
  let yanked: string | null = null
  let undo = false
  let cleared = false
  for (const k of keys) {
    const r = vimHandleKey(st, doc, k, Date.now(), reg)
    st = r.state
    doc = r.doc
    if (r.yanked) { yanked = r.yanked; reg = r.yanked }
    if (r.undo) undo = true
    if (r.cleared) cleared = true
  }
  return { st, doc, yanked, reg, undo, cleared }
}

const N = (t = 0) => ({ text: 'hello world', cursor: t })

describe('vim 模态与移动（gemini 同档子集）', () => {
  it('insert 起步；Esc 进 normal；insert 内普通字符放行（consumed=false）', () => {
    const st0 = initialVimState()
    expect(st0.mode).toBe('insert')
    const a = vimHandleKey(st0, N(0), 'x', 0, '')
    expect(a.consumed).toBe(false) // insert 字符放行给正常输入
    const b = vimHandleKey(st0, N(0), 'Escape', 0, '')
    expect(b.state.mode).toBe('normal')
  })

  it('hjkl + 0/$/^/gg/G 移动与多行 j/k', () => {
    const doc = { text: 'ab\ncd', cursor: 0 }
    expect(run(['Escape', 'l'], doc).doc.cursor).toBe(1)
    expect(run(['Escape', 'h'], { text: 'ab', cursor: 1 }).doc.cursor).toBe(0)
    expect(run(['Escape', 'j'], doc).doc.cursor).toBe(3) // 下一行同列
    expect(run(['Escape', '$'], { text: 'abc', cursor: 0 }).doc.cursor).toBe(2)
    expect(run(['Escape', '0'], { text: 'abc', cursor: 2 }).doc.cursor).toBe(0)
    expect(run(['Escape', '^'], { text: '  ab', cursor: 4 }).doc.cursor).toBe(2)
    expect(run(['Escape', 'G'], { text: 'a\nb', cursor: 0 }).doc.cursor).toBe(2)
    expect(run(['Escape', 'gg'], { text: 'a\nb', cursor: 2 }).doc.cursor).toBe(0)
  })

  it('w/b/e 与 W/B/E 词移动（含计数前缀 ×10 累积）', () => {
    const doc = { text: 'aa bb-cc dd', cursor: 0 }
    expect(run(['Escape', 'w'], doc).doc.cursor).toBe(3)
    expect(run(['Escape', 'e'], doc).doc.cursor).toBe(1)
    // 2w：bb 之后下一词是 cc（标点 - 为词界）——vim 同款
    expect(run(['Escape', '2', 'w'], doc).doc.cursor).toBe(6)
    expect(run(['Escape', '1', '2', 'w'], { text: 'x'.repeat(20), cursor: 0 }).doc.cursor).toBe(20) // 12 个 w 夹取到文末（单词内重复）
    // 大词：b-b 不算分隔
    expect(run(['Escape', 'W'], { text: 'a bb-cc d', cursor: 0 }).doc.cursor).toBe(2)
  })

  it('f/F/t/T 行内查找（预读编码 <find:ch>；找不到原地不动）', () => {
    const doc = { text: 'axbxc', cursor: 0 }
    expect(run(['Escape', 'f', '<find:x>'], doc).doc.cursor).toBe(1)
    expect(run(['Escape', '2', 'f', '<find:x>'], doc).doc.cursor).toBe(3) // 第二个 x
    expect(run(['Escape', 't', '<find:b>'], doc).doc.cursor).toBe(1) // 落在 b 前
    expect(run(['Escape', 'F', '<find:a>'], { text: 'ba', cursor: 2 }).doc.cursor).toBe(1)
    expect(run(['Escape', 'f', '<find:z>'], doc).doc.cursor).toBe(0) // 无匹配不动
  })

  it('双击 Esc 500ms 内清空（正常模式）', () => {
    const r = vimHandleKey({ ...initialVimState(), mode: 'normal', lastEscTs: 400 }, N(5), 'Escape', 600, '')
    expect(r.cleared).toBe(true)
    expect(r.doc.text).toBe('')
    const r2 = vimHandleKey({ ...initialVimState(), mode: 'normal', lastEscTs: 400 }, N(5), 'Escape', 950, '')
    expect(r2.cleared).toBe(false) // 超 500ms 不清空
  })
})

describe('vim 编辑命令', () => {
  it('x/X 删除字符进寄存器；r 替换不动光标；~ 大小写翻转', () => {
    const x = run(['Escape', 'x'], { text: 'abc', cursor: 0 })
    expect(x.doc.text).toBe('bc')
    expect(x.yanked).toBe('a')
    const X = run(['Escape', 'X'], { text: 'abc', cursor: 1 })
    expect(X.doc.text).toBe('bc')
    const r = run(['Escape', 'r', '<replace:Z>'], { text: 'abc', cursor: 0 })
    expect(r.doc.text).toBe('Zbc')
    expect(r.doc.cursor).toBe(0) // r 不移动光标
    const t = run(['Escape', '~'], { text: 'aBc', cursor: 0 })
    expect(t.doc.text).toBe('ABc')
  })

  it('dd/yy/cc/D/C/Y 行级操作', () => {
    const dd = run(['Escape', 'd', 'd'], { text: 'a\nb\nc', cursor: 0 })
    expect(dd.doc.text).toBe('b\nc')
    expect(dd.yanked).toBe('a\n')
    const yy = run(['Escape', 'y', 'y'], { text: 'a\nb', cursor: 0 })
    expect(yy.doc.text).toBe('a\nb') // 复制不改文本
    expect(yy.yanked).toBe('a\n')
    const cc = run(['Escape', 'c', 'c'], { text: 'a\nb', cursor: 0 })
    expect(cc.doc.text).toBe('\nb') // 清行留换行
    expect(cc.st.mode).toBe('insert') // c 进 insert
    const D = run(['Escape', 'D'], { text: 'ab cd', cursor: 2 })
    expect(D.doc.text).toBe('ab')
    const C = run(['Escape', 'C'], { text: 'ab cd', cursor: 2 })
    expect(C.doc.text).toBe('ab')
    expect(C.st.mode).toBe('insert')
    const Y = run(['Escape', 'Y'], { text: 'ab\ncd', cursor: 0 })
    expect(Y.yanked).toBe('ab\n')
  })

  it('操作符+移动：dw/d2w/cw/yw（右含式删除）+ 计数前缀', () => {
    const dw = run(['Escape', 'd', 'w'], { text: 'aa bb cc', cursor: 0 })
    expect(dw.doc.text).toBe('bb cc')
    const d2w = run(['Escape', 'd', '2', 'w'], { text: 'aa bb cc', cursor: 0 })
    expect(d2w.doc.text).toBe('cc')
    const cw = run(['Escape', 'c', 'w'], { text: 'aa bb', cursor: 0 })
    expect(cw.doc.text).toBe('bb')
    expect(cw.st.mode).toBe('insert')
    const yw = run(['Escape', 'y', 'w'], { text: 'aa bb', cursor: 0 })
    expect(yw.yanked).toBe('aa ')
    expect(yw.doc.text).toBe('aa bb')
  })

  it('p/P 粘贴寄存器；u 发撤销信号', () => {
    const p = run(['Escape', 'x', 'p'], { text: 'ab', cursor: 0 })
    expect(p.doc.text).toBe('ba') // x 删 a 进寄存器，p 粘到光标后
    const P = run(['Escape', 'x', 'P'], { text: 'ab', cursor: 0 })
    expect(P.doc.text).toBe('ab') // 删 a 再粘回
    const u = run(['Escape', 'u'], { text: 'ab', cursor: 0 })
    expect(u.undo).toBe(true)
  })

  it('. 重复上次命令（dd/x/操作符含计数）', () => {
    const dd = run(['Escape', 'd', 'd', '.', '.'], { text: 'a\nb\nc', cursor: 0 })
    expect(dd.doc.text).toBe('') // 三行全删
    const x3 = run(['Escape', '3', 'x', '.'], { text: 'abcdef', cursor: 0 })
    expect(x3.doc.text).toBe('') // 3x 再重复一次
  })

  it('i/a/o/O/I/A 进入 insert 且光标落位正确', () => {
    const doc = { text: 'ab', cursor: 0 }
    expect(run(['Escape', 'i'], doc).doc.cursor).toBe(0)
    expect(run(['Escape', 'a'], doc).doc.cursor).toBe(1)
    const o = run(['Escape', 'o'], doc)
    expect(o.doc.text).toBe('ab\n')
    expect(o.doc.cursor).toBe(3)
    const O = run(['Escape', 'O'], doc)
    expect(O.doc.text).toBe('\nab')
    expect(O.doc.cursor).toBe(0)
    expect(run(['Escape', 'A'], doc).doc.cursor).toBe(2)
    expect(run(['Escape', 'I'], { text: '  ab', cursor: 4 }).doc.cursor).toBe(2)
  })

  it('未识别键无动作（状态保留）；操作符+未知键取消挂起', () => {
    const unk = run(['Escape', '?'], { text: 'ab', cursor: 0 })
    expect(unk.doc).toEqual({ text: 'ab', cursor: 0 })
    const cancel = run(['Escape', 'd', '?'], { text: 'ab', cursor: 0 })
    expect(cancel.st.pendingOp).toBeNull()
    expect(cancel.doc.text).toBe('ab')
  })
})
