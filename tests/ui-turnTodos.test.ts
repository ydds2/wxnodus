// tests/ui-turnTodos.test.ts — A22 实时任务清单合成（纯函数单测）
import { describe, expect, it } from 'vitest'

import { seedTurnTodos, syncToolTodo } from '../src/wxnodus-ui/lib/turnTodos.js'
import type { TodoItem } from '../src/wxnodus-ui/types.js'

describe('seedTurnTodos（复杂度启发式）', () => {
  it('长需求先给骨架清单（理解需求→制定方案→执行）', () => {
    const todos = seedTurnTodos('请帮我实现一个完整的待办事项系统，包含增删改查、分类、搜索、统计面板……')

    expect(todos).toHaveLength(3)
    expect(todos[0]).toMatchObject({ id: 'tpl-understand', status: 'in_progress' })
    expect(todos[1]).toMatchObject({ id: 'tpl-plan', status: 'pending' })
    expect(todos[2]).toMatchObject({ id: 'tpl-execute', status: 'pending' })
  })

  it('含任务动词的短需求也触发骨架', () => {
    expect(seedTurnTodos('修复登录页崩溃')).toHaveLength(3)
    expect(seedTurnTodos('分析这份日志')).toHaveLength(3)
  })

  it('简单请求返回空清单（不打扰——无清单比假清单诚实）', () => {
    expect(seedTurnTodos('你好')).toEqual([])
    expect(seedTurnTodos('')).toEqual([])
    expect(seedTurnTodos(undefined)).toEqual([])
  })
})

describe('syncToolTodo（工具序列 → 清单）', () => {
  it('start 落地新行并标 in_progress；前一行归为 completed（串行语义）', () => {
    let todos = syncToolTodo([], 'fs_read', 't1', true, { path: 'a.txt' }, false)

    expect(todos).toEqual([{ id: 'tool:t1', content: '读取文件 a.txt', status: 'in_progress' }])

    todos = syncToolTodo(todos, 'bash', 't2', true, { command: 'npm test' }, false)

    expect(todos[0]!.status).toBe('completed')
    expect(todos[1]).toMatchObject({ id: 'tool:t2', content: '执行命令 npm test', status: 'in_progress' })
  })

  it('complete 成功 → completed；失败 → cancelled', () => {
    let todos = syncToolTodo([], 'fs_read', 't1', true, { path: 'a.txt' }, false)
    todos = syncToolTodo(todos, 'fs_read', 't1', false, undefined, true)

    expect(todos[0]!.status).toBe('completed')

    todos = syncToolTodo(todos, 'bash', 't2', true, { command: 'x' }, false)
    todos = syncToolTodo(todos, 'bash', 't2', false, undefined, false)

    expect(todos[1]!.status).toBe('cancelled')
  })

  it('骨架清单在首个真实工具出现时整体让位（骨架只是预判）', () => {
    const skeleton = seedTurnTodos('请帮我实现一个完整的待办事项系统……')
    const todos = syncToolTodo(skeleton, 'memory_search', 't1', true, { query: '待办' }, false)

    expect(todos.some(t => t.id.startsWith('tpl-'))).toBe(false)
    expect(todos).toEqual([{ id: 'tool:t1', content: '检索记忆 待办', status: 'in_progress' }])
  })

  it('重复 start（同 id 重跑）不产生重复行——已完成行保持 ✓（内核每次执行都是新 id，此路径仅在重放时出现）', () => {
    let todos = syncToolTodo([], 'fs_read', 't1', true, { path: 'a.txt' }, false)
    todos = syncToolTodo(todos, 'fs_read', 't1', false, undefined, true)
    todos = syncToolTodo(todos, 'fs_read', 't1', true, { path: 'a.txt' }, false)

    expect(todos).toHaveLength(1)
    expect(todos[0]!.status).toBe('completed')
  })

  it('纯函数：不修改入参列表', () => {
    const input: TodoItem[] = []
    const out = syncToolTodo(input, 'ls', 't1', true, {}, false)

    expect(input).toEqual([])
    expect(out).toHaveLength(1)
  })
})
