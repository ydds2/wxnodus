// tests/recent-actions.test.ts — P2 增强：最近动作存储契约（记录/去重/上限/顺序）
import { describe, expect, it, beforeEach } from 'vitest'
import { clearRecentActions, getRecentActions, recordRecentAction, RECENT_ACTIONS_MAX } from '../src/wxnodus-ui/runtime/recentActions.js'

beforeEach(() => clearRecentActions())

describe('recordRecentAction', () => {
  it('记录并按最近在前排序', () => {
    recordRecentAction('/diff turn')
    recordRecentAction('/status')
    expect(getRecentActions()).toEqual(['/status', '/diff turn'])
  })

  it('空文本/纯空白忽略', () => {
    recordRecentAction('   ')
    recordRecentAction('')
    expect(getRecentActions()).toEqual([])
  })

  it('重复动作去重并提到最前', () => {
    recordRecentAction('/status')
    recordRecentAction('/diff turn')
    recordRecentAction('/status')
    expect(getRecentActions()).toEqual(['/status', '/diff turn'])
  })

  it(`上限 ${RECENT_ACTIONS_MAX} 条（截尾）`, () => {
    for (let i = 0; i < RECENT_ACTIONS_MAX + 3; i++) {
      recordRecentAction(`/cmd${i}`)
    }
    const actions = getRecentActions()
    expect(actions).toHaveLength(RECENT_ACTIONS_MAX)
    expect(actions[0]).toBe(`/cmd${RECENT_ACTIONS_MAX + 2}`)
    // 最旧的 3 条被截掉
    expect(actions).not.toContain('/cmd0')
    expect(actions).not.toContain('/cmd1')
    expect(actions).not.toContain('/cmd2')
  })
})
