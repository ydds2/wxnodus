// src/wxnodus-ui/runtime/presentationReducer.ts — 阶段 2：presentation read-model（view-only 纯 reducer）
// 用途：把 gateway/流程事件投影为单栏 UI 所需的展示快照，与 operational stores（flowStore/viewStore）
// 并行存在——迁移期不夺走 operational source of truth。eventAdapter 把经 session/generation
// guard 过滤后的事件喂入；reducer 自身再防御性校验一次（迟到事件直接丢弃）。
// 纯函数：同一事件序列 → 确定性快照；不读取全局、不产生副作用。
import { evidenceReducer, type EvidenceEvent, type EvidenceSnapshot, type EvidenceStatus } from './evidenceModel.js'

export type SessionLifecycle = 'starting' | 'connecting' | 'ready' | 'recovering' | 'offline' | 'exhausted'

export type TurnPhase =
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'evidence'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_approval'
  | 'offline_blocked'

export type PromptKind = 'approval' | 'confirm' | 'clarify' | 'sudo' | 'secret' | 'form'

/** 严格优先级：approval → confirm → clarify → sudo → secret → form（与 PromptZone 一致）。 */
const PROMPT_PRIORITY: readonly PromptKind[] = ['approval', 'confirm', 'clarify', 'sudo', 'secret', 'form']

export interface PromptView {
  kind: PromptKind
  id: string
  summary: string
}

export interface PresentationMsg {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  at: number
}

export interface ActivityEntry {
  id: string
  toolId: string
  name: string
  context?: string
  status: 'running' | 'succeeded' | 'failed'
  summary?: string
  at: number
}

export interface TodoView {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export interface NoticeView {
  text: string
  level: 'info' | 'warn' | 'error'
}

export interface PresentationState {
  sessionId: null | string
  generation: number
  lifecycle: SessionLifecycle
  phase: TurnPhase
  busy: boolean
  interrupted: boolean
  history: PresentationMsg[]
  streaming: string
  activity: ActivityEntry[]
  todos: TodoView[]
  evidence: EvidenceSnapshot
  /** 当前打开的全部 flow prompt（按打开顺序）；blockingPrompt 是其中的派生最高优先级视图 */
  openPrompts: PromptView[]
  blockingPrompt: null | PromptView
  notice: null | NoticeView
  bgJobs: number
  bgTerms: number
  bgGoalActive: boolean
}

export const initialPresentationState = (): PresentationState => ({
  sessionId: null,
  generation: 0,
  lifecycle: 'starting',
  phase: 'completed',
  busy: false,
  interrupted: false,
  history: [],
  streaming: '',
  activity: [],
  todos: [],
  evidence: { items: {} },
  openPrompts: [],
  blockingPrompt: null,
  notice: null,
  bgJobs: 0,
  bgTerms: 0,
  bgGoalActive: false
})

export type PresentationEvent = {
  sessionId: string
  generation: number
} & (
  | { type: 'session.changed'; at?: number }
  | { type: 'lifecycle'; value: SessionLifecycle }
  | { type: 'turn.start'; at?: number }
  | { type: 'turn.phase'; phase: TurnPhase }
  | { type: 'turn.interrupted'; at?: number }
  | { type: 'message.delta'; text: string; at?: number; reset?: boolean }
  | { type: 'message.complete'; text: string; role?: 'assistant' | 'system'; at?: number }
  | { type: 'tool.start'; id: string; name: string; context?: string; at?: number }
  | { type: 'tool.complete'; id: string; ok: boolean; summary?: string; at?: number }
  | { type: 'todo.update'; items: TodoView[] }
  | { type: 'prompt.opened'; kind: PromptKind; id: string; summary: string }
  | { type: 'prompt.closed'; id: string }
  | { type: 'notice.show'; text: string; level: NoticeView['level'] }
  | { type: 'notice.clear' }
  | { type: 'bg.update'; jobs: number; terms: number; goalActive: boolean }
  | { type: 'evidence'; event: EvidenceEvent }
)

/** 去掉 sessionId/generation 元数据后的事件体（测试构造事件时用，避免分布式 Omit 陷阱）。 */
export type PresentationEventBody = PresentationEvent extends infer E
  ? E extends { sessionId: string; generation: number }
    ? Omit<E, 'sessionId' | 'generation'>
    : never
  : never

// id 与 at 都必须是事件序列的纯函数——不能用 Date.now()/模块计数器，否则
// 同一事件序列两次运行得不到确定性快照（阶段 2 验收硬指标）。
// id 用当前数组长度索引；缺省 at 用 0，需要真实时间戳的事件显式携带 at。
const msgId = (state: PresentationState): string => `msg-${state.history.length}`
const actId = (state: PresentationState): string => `act-${state.activity.length}`

/** 迟到事件守卫：
 *  - generation 更旧 → 丢弃；
 *  - 已建立会话（sessionId 非 null）且 session 不匹配 → 丢弃（旧 session 延迟事件不改当前会话）；
 *  - session.changed 是唯一合法的换会话入口，只受 generation 守卫；
 *  - 初始态（sessionId null）接受首个事件并隐式建立会话。 */
export const isStaleEvent = (state: PresentationState, event: PresentationEvent): boolean => {
  if (event.generation < state.generation) {
    return true
  }

  if (event.type === 'session.changed') {
    return false
  }

  return state.sessionId !== null && event.sessionId !== state.sessionId
}

/** 最高优先级 prompt（只显示一个；隐藏 prompt 仍在 openPrompts 中等待回落）。 */
const topPrompt = (prompts: readonly PromptView[]): null | PromptView => {
  for (const kind of PROMPT_PRIORITY) {
    const hit = prompts.find(p => p.kind === kind)

    if (hit) {
      return hit
    }
  }

  return null
}

const PROMPT_TO_PHASE: Partial<Record<PromptKind, TurnPhase>> = {
  approval: 'waiting_approval',
  sudo: 'waiting_approval'
}

const turnReset = (state: PresentationState, over: Partial<PresentationState> = {}): PresentationState => ({
  ...state,
  streaming: '',
  activity: [],
  todos: [],
  interrupted: false,
  openPrompts: [],
  blockingPrompt: null,
  ...over
})

export function presentationReducer(state: PresentationState, event: PresentationEvent): PresentationState {
  if (isStaleEvent(state, event)) {
    return state
  }

  // 隐式建立会话：初始态（sessionId null）接受首个事件，会话/代数随之落定。
  const current =
    state.sessionId === null ? { ...state, sessionId: event.sessionId, generation: event.generation } : state

  const at = ('at' in event && typeof event.at === 'number' ? event.at : undefined) ?? 0

  switch (event.type) {
    case 'session.changed':
      // 会话边界：清空所有回合态；证据快照随会话重置（不跨会话冒充 verified）。
      return {
        ...initialPresentationState(),
        sessionId: event.sessionId,
        generation: event.generation,
        lifecycle: current.lifecycle === 'starting' ? 'connecting' : current.lifecycle
      }

    case 'lifecycle':
      return { ...current, lifecycle: event.value }

    case 'turn.start':
      return turnReset(current, { phase: 'planning', busy: true, interrupted: false })

    case 'turn.phase':
      return { ...current, phase: event.phase }

    case 'message.delta':
      // V4 P0-9（A-4）：reset 时清空半截流文本（模型调用瞬时失败重试重发前发）——
      // 杜绝失败尝试的部分输出与重试全文拼接显示
      return event.reset
        ? { ...current, streaming: event.text }
        : { ...current, streaming: current.streaming + event.text }

    case 'message.complete': {
      const text = event.text
      const history = text
        ? [...current.history, { id: msgId(current), role: event.role ?? 'assistant', text, at }]
        : current.history

      return {
        ...current,
        history,
        streaming: '',
        busy: false,
        phase: current.interrupted ? 'cancelled' : 'completed'
      }
    }

    case 'tool.start':
      return {
        ...current,
        activity: [
          ...current.activity,
          { id: actId(current), toolId: event.id, name: event.name, context: event.context, status: 'running', at }
        ]
      }

    case 'tool.complete':
      return {
        ...current,
        activity: [
          ...current.activity,
          {
            id: actId(current),
            toolId: event.id,
            name: current.activity.find(a => a.toolId === event.id)?.name ?? event.id,
            status: event.ok ? 'succeeded' : 'failed',
            summary: event.summary,
            at
          }
        ]
      }

    case 'todo.update':
      return { ...current, todos: event.items }

    case 'prompt.opened': {
      const view: PromptView = { kind: event.kind, id: event.id, summary: event.summary }
      const openPrompts = [...current.openPrompts.filter(p => p.id !== event.id), view]
      const blockingPrompt = topPrompt(openPrompts)

      return {
        ...current,
        openPrompts,
        blockingPrompt,
        phase: blockingPrompt ? (PROMPT_TO_PHASE[blockingPrompt.kind] ?? current.phase) : current.phase
      }
    }

    case 'prompt.closed': {
      const openPrompts = current.openPrompts.filter(p => p.id !== event.id)
      const blockingPrompt = topPrompt(openPrompts)

      return {
        ...current,
        openPrompts,
        blockingPrompt,
        phase: blockingPrompt
          ? current.phase
          : current.interrupted
            ? 'cancelled'
            : current.busy
              ? current.phase
              : 'completed'
      }
    }

    case 'notice.show':
      return { ...current, notice: { text: event.text, level: event.level } }

    case 'notice.clear':
      return { ...current, notice: null }

    case 'bg.update':
      return { ...current, bgJobs: event.jobs, bgTerms: event.terms, bgGoalActive: event.goalActive }

    case 'turn.interrupted':
      return { ...current, interrupted: true, streaming: '', busy: false, phase: 'cancelled' }

    case 'evidence':
      return { ...current, evidence: evidenceReducer(current.evidence, event.event) }

    default:
      // 未知事件只可诊断，不修改快照。
      return current
  }
}

export type { EvidenceStatus }
