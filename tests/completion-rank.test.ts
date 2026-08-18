// tests/completion-rank.test.ts — 波 2 ② 7→8：@补全排序分层/frecency 权重/enter 双语义
// crush completions.go:205-260 / opencode frecency.tsx:10-42 / kimi prompt.py:1276-1290 对标
import { describe, expect, it } from 'vitest'
import { completionEnterAction, rankCompletions, withFrecency } from '../src/wxnodus-ui/lib/completionRank.js'

describe('rankCompletions（crush 分层排序）', () => {
  it('basename 精确 > basename 前缀 > display 前缀 > 路径段前缀', () => {
    const items = [
      { display: 'docs/util-notes/a.md' }, // 路径段前缀
      { display: 'src/util.ts' }, // basename 前缀
      { display: 'README.md' }, // 不匹配
      { display: 'util' }, // basename 精确（文件名恰为 util）
      { display: 'util.md' }, // basename 前缀
    ]
    const ranked = rankCompletions(items, 'util')
    expect(ranked.map(i => i.display)).toEqual(['util', 'src/util.ts', 'util.md', 'docs/util-notes/a.md', 'README.md'])
  })

  it('空/大小写前缀：大小写不敏感分层；无匹配保序垫底', () => {
    const items = [{ display: 'Main.ts' }, { display: 'x.ts' }]
    expect(rankCompletions(items, 'main').map(i => i.display)).toEqual(['Main.ts', 'x.ts'])
  })
})

describe('withFrecency（opencode frecency 权重）', () => {
  it('frecency 降序稳定重排；未记录项保序垫底', () => {
    const items = [{ display: 'a', text: 'a' }, { display: 'b', text: 'b' }, { display: 'c', text: 'c' }]
    const freq = new Map([['b', 3], ['c', 1]])
    expect(withFrecency(items, freq).map(i => i.display)).toEqual(['b', 'c', 'a'])
  })

  it('frecency 相同时保持输入相对顺序（稳定）', () => {
    const items = [{ display: 'x', text: 'x' }, { display: 'y', text: 'y' }]
    expect(withFrecency(items, new Map([['x', 2], ['y', 2]])).map(i => i.display)).toEqual(['x', 'y'])
  })
})

describe('completionEnterAction（kimi enter 双语义）', () => {
  it('slash 接受 = 替换为完整命令并立即提交', () => {
    const r = completionEnterAction('slash', '/compact', '/com', 1)
    expect(r).toEqual({ next: '/compact', submit: true })
  })

  it('path/agent 接受 = 只替换 token 不提交（保留 @ 前缀，替换至行尾）', () => {
    expect(completionEnterAction('path', '@src/a.ts', '看 @sr', 2)).toEqual({ next: '看 @src/a.ts', submit: false })
    expect(completionEnterAction('agent', '@explore', '让 @exp', 2)).toEqual({ next: '让 @explore', submit: false })
  })
})
