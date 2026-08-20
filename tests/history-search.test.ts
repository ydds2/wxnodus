// tests/history-search.test.ts — ② Ctrl+R 反向搜索纯函数（codex history_search.rs:55-134 对标：草稿快照/实时匹配/Esc 还原语义在组件层，纯函数契约在此固化）
import { describe, expect, it } from 'vitest'
import { searchHistory, searchHistoryWrapped } from '../src/wxnodus-ui/lib/historySearch.js'

const H = ['第一次构建', 'fix: hello world', '读 README 的说明', 'fix: hello again']

describe('searchHistory（向前更旧查找）', () => {
  it('从 beforeIndex 向前查找第一个子串匹配（大小写不敏感，最近优先）', () => {
    expect(searchHistory(H, 'hello', H.length)).toEqual({ index: 3, text: 'fix: hello again' })
    expect(searchHistory(H, 'HELLO', H.length)).toEqual({ index: 3, text: 'fix: hello again' })
  })

  it('beforeIndex 之前的更旧匹配（Ctrl+R 逐次回退）', () => {
    const first = searchHistory(H, 'hello', H.length)!
    const older = searchHistory(H, 'hello', first.index)
    expect(older!.index).toBe(1)
    expect(searchHistory(H, 'hello', first.index + 1)).toEqual(first) // 不含当前
  })

  it('空 query → 最近一条；无匹配 → null', () => {
    expect(searchHistory(H, '', H.length)).toEqual({ index: 3, text: 'fix: hello again' })
    expect(searchHistory(H, '不存在的词', H.length)).toBeNull()
  })
})

describe('searchHistoryWrapped（环绕）', () => {
  it('before 之前无匹配 → 从末尾环绕重试（bash readline 行为）', () => {
    expect(searchHistoryWrapped(H, '第一次', 1)!.index).toBe(0)
  })

  it('全程无匹配 → null（调用方显示「无匹配」）', () => {
    expect(searchHistoryWrapped(H, 'xxx', 1)).toBeNull()
  })
})
