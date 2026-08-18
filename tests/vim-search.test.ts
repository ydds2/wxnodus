// tests/vim-search.test.ts — P3 评估轮：vim / 搜索（六家对标）+ Ctrl-R redo 信号 + undo/redo 历史纯函数
import { describe, expect, it } from 'vitest'
import {
  findNextMatch, initialVimHistory, initialVimState,
  vimHandleKey, vimHistoryPush, vimHistoryRedo, vimHistoryUndo,
} from '../src/wxnodus-ui/lib/vimCore.js'

const run = (keys: string[], text: string, cursor = 0) => {
  let st = initialVimState()
  let doc = { text, cursor }
  for (const k of keys) {
    const r = vimHandleKey(st, doc, k, Date.now(), '')
    st = r.state
    doc = r.doc
  }
  return { st, doc }
}

describe('findNextMatch（回绕搜索）', () => {
  it('向前：先找光标后，再回绕到文首', () => {
    expect(findNextMatch('a b a', 0, 'a', 1)).toBe(4)
    expect(findNextMatch('a b a', 4, 'a', 1)).toBe(0) // 回绕
    expect(findNextMatch('a b a', 2, 'z', 1)).toBe(-1)
  })
  it('向后：先找光标前，再回绕到文尾', () => {
    expect(findNextMatch('a b a', 4, 'a', -1)).toBe(0)
    expect(findNextMatch('a b a', 0, 'a', -1)).toBe(4) // 回绕
  })
})

describe('/ 搜索状态机', () => {
  it('/ 进入搜索 → 逐字符匹配移动光标 → Enter 确认清搜索', () => {
    const s = run(['Escape', '/', 'b'], 'a b c b', 0)
    expect(s.doc.cursor).toBe(2)
    expect(s.st.search?.query).toBe('b')
    const c = run(['Escape', '/', 'b', 'c'], 'ab xbc ybc', 0)
    expect(c.doc.cursor).toBe(4) // 逐字符精化：b→1，bc→4
    const e = run(['Escape', '/', 'b', 'c', 'Enter'], 'ab xbc ybc', 0)
    expect(e.st.search).toBeNull()
    expect(e.doc.cursor).toBe(4) // 确认后光标留在匹配处
  })
  it('Esc 取消：还原锚点光标、清搜索、文本不动', () => {
    const r = run(['Escape', 'l', 'l', '/', 'c', 'Escape'], 'abcde', 0)
    expect(r.st.search).toBeNull()
    expect(r.doc.cursor).toBe(2) // 还原到进入搜索前的光标
    expect(r.doc.text).toBe('abcde')
  })
  it('? 向后搜索', () => {
    const r = run(['Escape', '?', 'a'], 'a x a', 4)
    expect(r.doc.cursor).toBe(0)
    expect(r.st.search?.dir).toBe(-1)
  })
  it('Backspace 退格重新匹配；无匹配保持光标', () => {
    const r = run(['Escape', '/', 'c', 'x', 'Backspace', 'Backspace'], 'abc', 0)
    expect(r.st.search?.query).toBe('')
    expect(r.doc.cursor).toBe(0)
    const none = run(['Escape', '/', 'z', 'z'], 'abc', 0)
    expect(none.doc.cursor).toBe(0) // 无匹配不动
  })
  it('搜索挂起期数字进查询不进 count；搜索清空 pendingOp', () => {
    const r = run(['Escape', 'd', '/', '1'], 'a1b', 0)
    expect(r.st.search?.query).toBe('1')
    expect(r.st.count).toBe(0)
    expect(r.st.pendingOp).toBeNull()
  })
})

describe('Ctrl-R redo 信号', () => {
  it('<redo> 返回 redo 信号（栈由 hook 管理）', () => {
    let st = initialVimState()
    st = { ...st, mode: 'normal' }
    const r = vimHandleKey(st, { text: 'x', cursor: 0 }, '<redo>', Date.now(), '')
    expect(r.redo).toBe(true)
    expect(r.doc.text).toBe('x')
  })
})

describe('undo/redo 历史纯函数', () => {
  it('push 清 redo；undo/redo 往返；空栈返回 null；上限 200', () => {
    let h = initialVimHistory()
    h = vimHistoryPush(h, { text: 'a', cursor: 0 })
    h = vimHistoryPush(h, { text: 'b', cursor: 1 })
    const u = vimHistoryUndo(h, { text: 'c', cursor: 2 })!
    expect(u.doc.text).toBe('b')
    expect(u.h.undo).toHaveLength(1)
    expect(u.h.redo).toHaveLength(1)
    const rr = vimHistoryRedo(u.h, { text: 'c', cursor: 2 })!
    expect(rr.doc.text).toBe('c')
    expect(rr.h.redo).toHaveLength(0)
    expect(vimHistoryUndo(initialVimHistory(), { text: 'x', cursor: 0 })).toBeNull()
    expect(vimHistoryRedo(initialVimHistory(), { text: 'x', cursor: 0 })).toBeNull()
    // 新编辑清 redo（vim 语义）
    const afterRedo = vimHistoryPush(rr.h, { text: 'd', cursor: 0 })
    expect(afterRedo.redo).toHaveLength(0)
    // 上限 200
    let big = initialVimHistory()
    for (let i = 0; i < 210; i++) big = vimHistoryPush(big, { text: String(i), cursor: 0 })
    expect(big.undo).toHaveLength(200)
    expect(big.undo[199]!.text).toBe('209')
  })
})
