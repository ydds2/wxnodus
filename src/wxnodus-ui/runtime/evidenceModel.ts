// src/wxnodus-ui/runtime/evidenceModel.ts — 阶段 2：证据状态机（view-only 纯 reducer）
// 红线：只有显式验证成功事件（verification.succeeded）能进入 verified。
// 助手文案、工具成功、todo 完成都不存在于此事件类型——UI 只能从真实验证事件/结果派生证据状态。
// 本模型是纯函数 + 事件注入：同一事件序列得到确定性快照；旧会话迟到事件经 session/generation guard 过滤后再喂入。

export type EvidenceStatus =
  | 'not-started'
  | 'pending'
  | 'running'
  | 'verified'
  | 'failed'
  | 'interrupted'
  | 'unavailable'
  | 'unknown'

export interface EvidenceItem {
  id: string
  status: Exclude<EvidenceStatus, 'unknown'>
  /** 进入 verified 的来源事件标识（真实验证事件，如 verification#42）——verified 项必须有 */
  sourceEvent?: string
  taskId?: string
  summary: string
  artifactRef?: string
  failedReason?: string
  startedAt?: number
  finishedAt?: number
}

export interface EvidenceSnapshot {
  items: Record<string, EvidenceItem>
  turnId?: string
}

/**
 * 唯一合法的事件集合。注意：不存在 "assistant text" / "tool success" /
 * "todo completed" 这类事件——模型类型层面就排除伪造 verified 的路径。
 */
export type EvidenceEvent =
  | { type: 'verification.started'; id: string; taskId?: string; summary: string; at: number }
  | { type: 'verification.succeeded'; id: string; sourceEvent: string; artifactRef?: string; at: number }
  | { type: 'verification.failed'; id: string; reason: string; at: number }
  | { type: 'verification.interrupted'; id: string; at: number }
  | { type: 'verification.unavailable'; id: string; reason?: string; at: number }

const base = (id: string, summary: string): EvidenceItem => ({
  id,
  status: 'not-started',
  summary
})

export function evidenceReducer(state: EvidenceSnapshot, event: EvidenceEvent): EvidenceSnapshot {
  switch (event.type) {
    case 'verification.started': {
      const existing = state.items[event.id]

      return {
        ...state,
        items: {
          ...state.items,
          [event.id]: {
            ...(existing ?? base(event.id, event.summary)),
            status: 'running',
            summary: event.summary,
            taskId: event.taskId ?? existing?.taskId,
            startedAt: existing?.startedAt ?? event.at,
            finishedAt: undefined,
            failedReason: undefined
          }
        }
      }
    }

    case 'verification.succeeded': {
      const existing = state.items[event.id]

      return {
        ...state,
        items: {
          ...state.items,
          [event.id]: {
            ...(existing ?? base(event.id, event.id)),
            status: 'verified',
            sourceEvent: event.sourceEvent,
            artifactRef: event.artifactRef ?? existing?.artifactRef,
            startedAt: existing?.startedAt,
            finishedAt: event.at,
            failedReason: undefined
          }
        }
      }
    }

    case 'verification.failed': {
      const existing = state.items[event.id]

      return {
        ...state,
        items: {
          ...state.items,
          [event.id]: {
            ...(existing ?? base(event.id, event.id)),
            status: 'failed',
            failedReason: event.reason,
            finishedAt: event.at
          }
        }
      }
    }

    case 'verification.interrupted': {
      const existing = state.items[event.id]

      return {
        ...state,
        items: {
          ...state.items,
          [event.id]: {
            ...(existing ?? base(event.id, event.id)),
            status: 'interrupted',
            finishedAt: event.at
          }
        }
      }
    }

    case 'verification.unavailable': {
      const existing = state.items[event.id]

      return {
        ...state,
        items: {
          ...state.items,
          [event.id]: {
            ...(existing ?? base(event.id, event.id)),
            status: 'unavailable',
            failedReason: event.reason,
            finishedAt: event.at
          }
        }
      }
    }

    default:
      // 未知事件只可诊断，不可提升证据状态——原样返回。
      return state
  }
}

/** 查单项状态；缺失/未知 id → 'unknown'（绝不默认 verified）。 */
export const evidenceStatusOf = (state: EvidenceSnapshot, id: string): EvidenceStatus =>
  state.items[id]?.status ?? 'unknown'

/** 汇总：failed > interrupted > pending（含 running/not-started）> verified > unknown（空）。 */
export const evidenceOverall = (state: EvidenceSnapshot): EvidenceStatus => {
  const items = Object.values(state.items)

  if (items.length === 0) {
    return 'unknown'
  }

  if (items.some(item => item.status === 'failed')) {
    return 'failed'
  }

  if (items.some(item => item.status === 'interrupted')) {
    return 'interrupted'
  }

  if (items.some(item => item.status !== 'verified')) {
    return 'pending'
  }

  return 'verified'
}
