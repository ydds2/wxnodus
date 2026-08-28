// src/wxnodus-ui/lib/turnTodos.ts — A22 实时任务清单合成（纯函数）
// 工具调用序列 → 可勾选清单（✓ 完成 / [>] 进行中）；复杂长需求先给骨架
// （理解需求→制定方案→执行），首个真实工具落地时骨架让位——骨架只是预判，
// 真实工具序列才是诚实清单。UI LiveTodoPanel 常驻显示。
import { briefToolContext } from '../../kernel/agent.js'
import type { TodoItem } from '../types.js'

const SKELETON_PREFIX = 'tpl-'

/** 复杂度启发式：长文本或含任务动词（实现/搭建/修复…）→ 骨架清单，让用户在
 *  agent 推理期就看到整体计划；简单请求不打扰（空清单——无清单比假清单诚实）。 */
export const seedTurnTodos = (prompt: unknown): TodoItem[] => {
  const text = String(prompt ?? '')
  const complex =
    text.length > 80 || /(实现|开发|搭建|修复|重构|设计|分析|调查|研究|规划|整理|构建|集成)/.test(text)
  if (!complex) return []
  return [
    { id: 'tpl-understand', content: '理解需求', status: 'in_progress' },
    { id: 'tpl-plan', content: '制定方案', status: 'pending' },
    { id: 'tpl-execute', content: '执行实施', status: 'pending' },
  ]
}

/** 工具事件流 → 清单（纯函数，返回新列表）：start 落地新行（串行语义——
 *  同一时刻只有一个在跑，上一进行中归为完成）；complete 收尾（✓/✗）。
 *  骨架行在首个真实工具出现时整体让位。 */
export const syncToolTodo = (
  todos: TodoItem[],
  name: string,
  toolId: string,
  isStart: boolean,
  args: unknown,
  ok: boolean
): TodoItem[] => {
  if (todos.length && todos.every(t => t.id.startsWith(SKELETON_PREFIX))) {
    todos = []
  }
  const id = `tool:${toolId}`
  if (isStart) {
    const existing = todos.find(t => t.id === id)
    if (existing) {
      return todos.map(t => (t.id === id && t.status !== 'completed' ? { ...t, status: 'in_progress' as const } : t))
    }
    return [
      ...todos.map(t => (t.status === 'in_progress' ? { ...t, status: 'completed' as const } : t)),
      { id, content: briefToolContext(name, args as Record<string, any> | undefined), status: 'in_progress' as const },
    ]
  }
  return todos.map(t => (t.id === id ? { ...t, status: ok ? ('completed' as const) : ('cancelled' as const) } : t))
}
