import { afterEach, describe, expect, it } from 'vitest'

import {
  archiveDoneTodos,
  archiveTodosAtTurnEnd,
  getTurnState,
  patchTurnState,
  resetTurnState
} from '../src/wxnodus-ui/runtime/flowStore.js'

afterEach(() => {
  resetTurnState()
})

describe('flowStore todo archive contract', () => {
  it('does not create an archive for an empty turn', () => {
    expect(archiveTodosAtTurnEnd()).toEqual([])
    expect(getTurnState().todos).toEqual([])
  })

  it.each([
    ['completed', [{ id: 'a', content: '完成项', status: 'completed' as const }]],
    ['cancelled', [{ id: 'a', content: '取消项', status: 'cancelled' as const }]],
    [
      'completed and cancelled',
      [
        { id: 'a', content: '完成项', status: 'completed' as const },
        { id: 'b', content: '取消项', status: 'cancelled' as const }
      ]
    ]
  ])('%s todos collapse by default when archived', (_label, todos) => {
    patchTurnState({ todos })

    const [message] = archiveTodosAtTurnEnd()

    expect(message).toMatchObject({
      kind: 'trail',
      role: 'system',
      text: '',
      todos,
      todoCollapsedByDefault: true
    })
    expect(message).not.toHaveProperty('todoIncomplete')
    expect(getTurnState().todos).toEqual([])
    expect(getTurnState().todoCollapsed).toBe(false)
  })

  it.each([
    ['pending', 'pending'],
    ['in progress', 'in_progress']
  ] as const)('%s todos remain visibly incomplete when archived', (_label, status) => {
    const todos = [{ id: 'a', content: '未完成项', status }]
    patchTurnState({ todos })

    const [message] = archiveTodosAtTurnEnd()

    expect(message).toMatchObject({ kind: 'trail', role: 'system', todos, todoIncomplete: true })
    expect(message).not.toHaveProperty('todoCollapsedByDefault')
    expect(getTurnState().todos).toEqual([])
  })

  it('archiveDoneTodos preserves the same archive semantics', () => {
    patchTurnState({ todos: [{ id: 'a', content: '保留', status: 'completed' }] })

    expect(archiveDoneTodos()[0]).toMatchObject({ todoCollapsedByDefault: true })
  })
})
