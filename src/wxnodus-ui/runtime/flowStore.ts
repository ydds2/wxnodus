import { createAtom as atom } from '../../app/stores/engine.js'
import { useSyncExternalStore } from 'react'

import { isTodoDone } from '../lib/liveProgress.js'
import type { ActiveTool, ActivityItem, DoneTool, Msg, SubagentProgress, TodoItem } from '../types.js'

const buildTurnState = (): TurnState => ({
  activity: [],
  doneTools: [],
  outcome: '',
  reasoning: '',
  reasoningActive: false,
  reasoningStreaming: false,
  reasoningTokens: 0,
  streamPendingTools: [],
  streamSegments: [],
  streaming: '',
  subagents: [],
  // 2026-08-19 降噪：Todo 默认折叠为单行摘要「▸ Todo (N/M)」（点击展开逐条）——
  // 长任务几十条 todo 不再刷屏；对标同类 CLI 紧凑输出
  todoCollapsed: true,
  todos: [],
  toolTokens: 0,
  tools: [],
  turnTrail: []
})

export const $turnState = atom<TurnState>(buildTurnState())

export const getTurnState = () => $turnState.get()

const subscribeTurn = (cb: () => void) => $turnState.listen(() => cb())

export const useTurnSelector = <T>(selector: (state: TurnState) => T): T =>
  useSyncExternalStore(
    subscribeTurn,
    () => selector($turnState.get()),
    () => selector($turnState.get())
  )

export const patchTurnState = (next: Partial<TurnState> | ((state: TurnState) => TurnState)) =>
  $turnState.set(typeof next === 'function' ? next($turnState.get()) : { ...$turnState.get(), ...next })

export const toggleTodoCollapsed = () => patchTurnState(state => ({ ...state, todoCollapsed: !state.todoCollapsed }))

export const archiveDoneTodos = () => archiveTodosAtTurnEnd()

export const archiveTodosAtTurnEnd = () => {
  const state = $turnState.get()

  if (!state.todos.length) {
    return []
  }

  const done = isTodoDone(state.todos)

  const msg: Msg = {
    kind: 'trail',
    role: 'system',
    text: '',
    todos: state.todos,
    ...(done ? { todoCollapsedByDefault: true } : { todoIncomplete: true })
  }

  patchTurnState({ todoCollapsed: true, todos: [] })

  return [msg]
}

export const resetTurnState = () => $turnState.set(buildTurnState())

export interface TurnState {
  activity: ActivityItem[]
  /** 结构化完成的工具记录（活动分区）——startMessage 清空，turn 结束保留供分区展示 */
  doneTools: DoneTool[]
  outcome: string
  reasoning: string
  reasoningActive: boolean
  reasoningStreaming: boolean
  reasoningTokens: number
  streamPendingTools: string[]
  streamSegments: Msg[]
  streaming: string
  subagents: SubagentProgress[]
  todoCollapsed: boolean
  todos: TodoItem[]
  toolTokens: number
  tools: ActiveTool[]
  turnTrail: string[]
}
